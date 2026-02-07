#!/bin/bash
set -e

# Engram AWS EC2 Deployment Script
# Deploys Engram to your AWS account with SSM-based access (no public ports)

INSTANCE_TYPE="${INSTANCE_TYPE:-t3.small}"
ENGRAM_DIR="${ENGRAM_DIR:-$HOME/.engram}"
KEY_NAME="engram-server-$(date +%s)"

# Track created resources for cleanup on failure
CREATED_KEY=""
CREATED_INSTANCE=""

cleanup_on_failure() {
    echo ""
    echo "⚠ Deployment failed. Cleaning up..."
    
    if [ -n "$CREATED_INSTANCE" ]; then
        echo "  Terminating instance $CREATED_INSTANCE..."
        aws ec2 terminate-instances --instance-ids "$CREATED_INSTANCE" &>/dev/null || true
    fi
    
    if [ -n "$CREATED_KEY" ]; then
        echo "  Deleting key pair $CREATED_KEY..."
        aws ec2 delete-key-pair --key-name "$CREATED_KEY" &>/dev/null || true
        rm -f "$ENGRAM_DIR/$CREATED_KEY.pem" 2>/dev/null || true
    fi
    
    echo "  Cleanup complete."
    exit 1
}

trap cleanup_on_failure ERR

echo "=== Engram AWS Deployment ==="
echo ""

# Pre-flight checks
echo "Checking prerequisites..."

if ! command -v aws &> /dev/null; then
    echo "❌ AWS CLI not found. Install: https://aws.amazon.com/cli/"
    exit 1
fi

if ! aws sts get-caller-identity &> /dev/null; then
    echo "❌ AWS credentials not configured. Run: aws configure (or aws sso login)"
    exit 1
fi

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=$(aws configure get region || echo "us-east-1")
echo "✓ AWS CLI configured (Account: $ACCOUNT_ID, Region: $REGION)"

# Get latest Amazon Linux 2023 AMI
echo ""
echo "Finding latest Amazon Linux 2023 AMI..."
AMI_ID=$(aws ec2 describe-images \
    --owners amazon \
    --filters "Name=name,Values=al2023-ami-2023*-x86_64" "Name=state,Values=available" \
    --query "Images | sort_by(@, &CreationDate) | [-1].ImageId" \
    --output text)

if [ "$AMI_ID" == "None" ] || [ -z "$AMI_ID" ]; then
    echo "❌ Could not find Amazon Linux 2023 AMI"
    exit 1
fi
echo "✓ AMI: $AMI_ID"

# Create key pair
echo ""
echo "Creating EC2 key pair..."
mkdir -p "$ENGRAM_DIR"
aws ec2 create-key-pair \
    --key-name "$KEY_NAME" \
    --query 'KeyMaterial' \
    --output text > "$ENGRAM_DIR/$KEY_NAME.pem"
chmod 600 "$ENGRAM_DIR/$KEY_NAME.pem"
CREATED_KEY="$KEY_NAME"
echo "✓ Key saved: $ENGRAM_DIR/$KEY_NAME.pem"

# Create IAM role for SSM (if doesn't exist)
echo ""
echo "Setting up IAM role for SSM..."
ROLE_NAME="engram-ec2-ssm-role"
INSTANCE_PROFILE_NAME="engram-ec2-ssm-profile"

if ! aws iam get-role --role-name "$ROLE_NAME" &> /dev/null; then
    aws iam create-role \
        --role-name "$ROLE_NAME" \
        --assume-role-policy-document '{
            "Version": "2012-10-17",
            "Statement": [{
                "Effect": "Allow",
                "Principal": {"Service": "ec2.amazonaws.com"},
                "Action": "sts:AssumeRole"
            }]
        }' > /dev/null
    
    aws iam attach-role-policy \
        --role-name "$ROLE_NAME" \
        --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
    
    echo "✓ Created IAM role: $ROLE_NAME"
else
    echo "✓ IAM role exists: $ROLE_NAME"
fi

if ! aws iam get-instance-profile --instance-profile-name "$INSTANCE_PROFILE_NAME" &> /dev/null; then
    aws iam create-instance-profile --instance-profile-name "$INSTANCE_PROFILE_NAME" > /dev/null
    aws iam add-role-to-instance-profile \
        --instance-profile-name "$INSTANCE_PROFILE_NAME" \
        --role-name "$ROLE_NAME"
    echo "✓ Created instance profile: $INSTANCE_PROFILE_NAME"
    echo "  Waiting 10s for IAM propagation..."
    sleep 10
else
    echo "✓ Instance profile exists: $INSTANCE_PROFILE_NAME"
fi

# User data script to install Bun and Engram
USER_DATA=$(cat << 'USERDATA'
#!/bin/bash
set -e

# Install git (not included in AL2023 minimal)
dnf install -y git

# Install Bun and Engram as ec2-user (sudo -i sets HOME correctly)
sudo -i -u ec2-user bash << 'EOF'
set -e
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"

# Clone and install Engram
cd ~
git clone https://github.com/shetty4l/engram.git
~/.bun/bin/bun install --cwd ~/engram
EOF

# Create data directory (needs root)
mkdir -p /data/engram
chown ec2-user:ec2-user /data/engram

# Signal completion
touch /home/ec2-user/.engram-ready
USERDATA
)

# Launch EC2 instance
echo ""
echo "Launching EC2 instance ($INSTANCE_TYPE)..."
INSTANCE_ID=$(aws ec2 run-instances \
    --image-id "$AMI_ID" \
    --instance-type "$INSTANCE_TYPE" \
    --key-name "$KEY_NAME" \
    --iam-instance-profile Name="$INSTANCE_PROFILE_NAME" \
    --user-data "$USER_DATA" \
    --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":10,"VolumeType":"gp3"}}]' \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=engram-server}]" \
    --query 'Instances[0].InstanceId' \
    --output text)

echo "✓ Instance launched: $INSTANCE_ID"
CREATED_INSTANCE="$INSTANCE_ID"

# Wait for instance to be running
echo ""
echo "Waiting for instance to start..."
aws ec2 wait instance-running --instance-ids "$INSTANCE_ID"
echo "✓ Instance running"

# Wait for SSM agent
echo ""
echo "Waiting for SSM agent (this may take 2-3 minutes)..."
for i in {1..30}; do
    if aws ssm describe-instance-information \
        --filters "Key=InstanceIds,Values=$INSTANCE_ID" \
        --query 'InstanceInformationList[0].InstanceId' \
        --output text 2>/dev/null | grep -q "$INSTANCE_ID"; then
        echo "✓ SSM agent connected"
        break
    fi
    if [ $i -eq 30 ]; then
        echo "⚠ SSM agent not responding. Instance may still be initializing."
        echo "  Try again in a few minutes with: aws ssm start-session --target $INSTANCE_ID"
    fi
    sleep 10
    echo "  Still waiting... ($i/30)"
done

# Wait for Engram installation
echo ""
echo "Waiting for Engram installation to complete..."
for i in {1..20}; do
    RESULT=$(aws ssm send-command \
        --instance-ids "$INSTANCE_ID" \
        --document-name "AWS-RunShellScript" \
        --parameters 'commands=["test -f /home/ec2-user/.engram-ready && echo READY || echo WAITING"]' \
        --query 'Command.CommandId' \
        --output text 2>/dev/null) || true
    
    if [ -n "$RESULT" ]; then
        sleep 3
        STATUS=$(aws ssm get-command-invocation \
            --command-id "$RESULT" \
            --instance-id "$INSTANCE_ID" \
            --query 'StandardOutputContent' \
            --output text 2>/dev/null) || true
        
        if [[ "$STATUS" == *"READY"* ]]; then
            echo "✓ Engram installed"
            break
        fi
    fi
    
    if [ $i -eq 20 ]; then
        echo "⚠ Installation check timed out. It may still be in progress."
    fi
    sleep 15
    echo "  Installing... ($i/20)"
done

# Generate MCP config
echo ""
echo "=== Deployment Complete ==="
echo ""
echo "Instance ID: $INSTANCE_ID"
echo "Key file: $ENGRAM_DIR/$KEY_NAME.pem"
echo ""
echo "Add this to your MCP client config:"
echo ""
cat << EOF
{
  "engram": {
    "command": "ssh",
    "args": [
      "-i", "$ENGRAM_DIR/$KEY_NAME.pem",
      "-o", "StrictHostKeyChecking=no",
      "-o", "ProxyCommand=aws ssm start-session --target $INSTANCE_ID --document-name AWS-StartSSHSession --parameters portNumber=%p",
      "ec2-user@$INSTANCE_ID",
      "cd ~/engram && ENGRAM_DB_PATH=/data/engram/engram.db ~/.bun/bin/bun run src/index.ts"
    ]
  }
}
EOF

echo ""
echo "Test connection: aws ssm start-session --target $INSTANCE_ID"
echo ""

# Save instance info
cat << EOF > "$ENGRAM_DIR/instance-info.txt"
INSTANCE_ID=$INSTANCE_ID
KEY_FILE=$ENGRAM_DIR/$KEY_NAME.pem
REGION=$REGION
CREATED=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
EOF

echo "Instance info saved to: $ENGRAM_DIR/instance-info.txt"
