import { SQSClient } from '@aws-sdk/client-sqs';
import { Pool } from 'pg';

export const deps = [SQSClient, Pool];
