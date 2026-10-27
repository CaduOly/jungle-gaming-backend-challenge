#!/usr/bin/env bash
set -euo pipefail

status=$(curl -sf http://localhost:4566/_localstack/init/ready)
grep -q '"completed": *true' <<<"$status"
grep -q '"name": *"init-sqs.sh", *"state": *"SUCCESSFUL"' <<<"$status"
if grep -q '"ERROR"' <<<"$status"; then exit 1; fi

for name in wagering-commands wagering-events; do
  awslocal sqs get-queue-attributes \
    --queue-url "http://localhost:4566/000000000000/${name}.fifo" \
    --attribute-names RedrivePolicy --query Attributes.RedrivePolicy --output text \
    | grep -q ":${name}-dlq.fifo"
done
