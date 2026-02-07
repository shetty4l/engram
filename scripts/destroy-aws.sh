#!/bin/bash
set -e

# Engram AWS Cleanup Script
# Removes EC2 instance and associated resources created by deploy-aws.sh

ENGRAM_DIR="${ENGRAM_DIR:-$HOME/.engram}"
INFO_FILE="$ENGRAM_DIR/instance-info.txt"

echo "=== Engram AWS Cleanup ==="
echo ""

# Check for instance info
if [ ! -f "$INFO_FILE" ]; then
    echo "No deployment found at $INFO_FILE"
    echo ""
    echo "Usage: $0 [instance-id]"
    echo ""
    echo "If you know your instance ID, pass it as an argument."
    
    if [ -n "$1" ]; then
        INSTANCE_ID="$1"
        KEY_FILE=""
    else
        exit 1
    fi
else
    source "$INFO_FILE"
    echo "Found deployment:"
    echo "  Instance: $INSTANCE_ID"
    echo "  Key file: $KEY_FILE"
    echo "  Region:   $REGION"
    echo "  Created:  $CREATED"
fi

# Allow override via argument
if [ -n "$1" ]; then
    INSTANCE_ID="$1"
fi

echo ""
read -p "Delete this Engram deployment? (y/N) " confirm

if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo "Cancelled."
    exit 0
fi

echo ""

# Get key name from instance (if we don't have KEY_FILE)
if [ -z "$KEY_FILE" ] && [ -n "$INSTANCE_ID" ]; then
    KEY_NAME=$(aws ec2 describe-instances \
        --instance-ids "$INSTANCE_ID" \
        --query 'Reservations[0].Instances[0].KeyName' \
        --output text 2>/dev/null) || true
else
    KEY_NAME=$(basename "${KEY_FILE:-.pem}" .pem)
fi

# Terminate instance
if [ -n "$INSTANCE_ID" ]; then
    echo "Terminating instance $INSTANCE_ID..."
    if aws ec2 terminate-instances --instance-ids "$INSTANCE_ID" &>/dev/null; then
        echo "✓ Instance terminating"
    else
        echo "⚠ Could not terminate instance (may already be terminated)"
    fi
fi

# Delete key pair
if [ -n "$KEY_NAME" ] && [ "$KEY_NAME" != "None" ]; then
    echo "Deleting key pair $KEY_NAME..."
    if aws ec2 delete-key-pair --key-name "$KEY_NAME" &>/dev/null; then
        echo "✓ Key pair deleted from AWS"
    else
        echo "⚠ Could not delete key pair (may already be deleted)"
    fi
fi

# Remove local key file
if [ -n "$KEY_FILE" ] && [ -f "$KEY_FILE" ]; then
    rm -f "$KEY_FILE"
    echo "✓ Local key file removed"
fi

# Remove instance info
if [ -f "$INFO_FILE" ]; then
    rm -f "$INFO_FILE"
    echo "✓ Instance info removed"
fi

echo ""
echo "=== Cleanup Complete ==="
echo ""
echo "Note: IAM role 'engram-ec2-ssm-role' was NOT deleted (may be shared)."
echo "To delete it manually:"
echo "  aws iam remove-role-from-instance-profile --instance-profile-name engram-ec2-ssm-profile --role-name engram-ec2-ssm-role"
echo "  aws iam delete-instance-profile --instance-profile-name engram-ec2-ssm-profile"
echo "  aws iam detach-role-policy --role-name engram-ec2-ssm-role --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
echo "  aws iam delete-role --role-name engram-ec2-ssm-role"
