#!/bin/sh
set -e

awslocal sqs create-queue --queue-name recording-analysis
awslocal sqs create-queue --queue-name recording-analysis-python
awslocal sqs create-queue --queue-name recording-analysis-dlq

echo "Local SQS queues created."
