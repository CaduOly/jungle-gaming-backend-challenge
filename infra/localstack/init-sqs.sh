#!/usr/bin/env bash
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
MAX_RECEIVE_COUNT="${SQS_MAX_RECEIVE_COUNT:-100}"

create_fifo() {
  awslocal sqs create-queue --region "$REGION" --queue-name "$1" \
    --attributes FifoQueue=true,ContentBasedDeduplication=false "${@:2}" \
    --query QueueUrl --output text
}

queue_arn() {
  awslocal sqs get-queue-attributes --region "$REGION" --queue-url "$1" \
    --attribute-names QueueArn --query Attributes.QueueArn --output text
}

create_with_dlq() {
  local name="$1"
  local dlq_url dlq_arn
  dlq_url=$(create_fifo "${name}-dlq.fifo")
  dlq_arn=$(queue_arn "$dlq_url")
  local queue_url
  queue_url=$(create_fifo "${name}.fifo")
  awslocal sqs set-queue-attributes --region "$REGION" --queue-url "$queue_url" \
    --attributes "{\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${dlq_arn}\\\",\\\"maxReceiveCount\\\":\\\"${MAX_RECEIVE_COUNT}\\\"}\"}"
  echo "created ${name}.fifo -> ${name}-dlq.fifo (maxReceiveCount=${MAX_RECEIVE_COUNT})"
}

create_with_dlq wager-transactions
create_with_dlq wagering-events
