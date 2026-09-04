#!/bin/sh
set -e

awslocal sqs create-queue --queue-name recording-analysis-dlq
awslocal sqs create-queue --queue-name recording-analysis --attributes '{"VisibilityTimeout":"300","RedrivePolicy":"{\"deadLetterTargetArn\":\"arn:aws:sqs:ap-northeast-2:000000000000:recording-analysis-dlq\",\"maxReceiveCount\":\"3\"}"}'
awslocal sqs create-queue --queue-name recording-analysis-python --attributes '{"RedrivePolicy":"{\"deadLetterTargetArn\":\"arn:aws:sqs:ap-northeast-2:000000000000:recording-analysis-dlq\",\"maxReceiveCount\":\"3\"}"}'

echo "Local SQS queues created."
