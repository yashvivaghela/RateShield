#!/usr/bin/env python3
"""
Query the UsageAggregates table for request counts per API key per hour.

Usage:
    python3 query_usage.py                  # show all usage, all keys
    python3 query_usage.py --key pro-key-1  # show usage for one key only

Requires: boto3 (pip install boto3 --break-system-packages)
AWS credentials must already be configured (same as the AWS CLI uses).
"""

import argparse
import boto3
from collections import defaultdict

TABLE_NAME = "UsageAggregates"


def fetch_all_usage(dynamodb, api_key: str | None = None):
    table = dynamodb.Table(TABLE_NAME)

    if api_key:
        # Query is efficient here: it only reads this one key's partition,
        # not the whole table.
        response = table.query(
            KeyConditionExpression="apiKey = :k",
            ExpressionAttributeValues={":k": api_key},
        )
        return response["Items"]
    else:
        # Scan reads the whole table. Fine for a project at this scale;
        # at real production volume you'd query per key instead, or
        # maintain a separate index for cross-key reporting.
        items = []
        response = table.scan()
        items.extend(response["Items"])
        while "LastEvaluatedKey" in response:
            response = table.scan(ExclusiveStartKey=response["LastEvaluatedKey"])
            items.extend(response["Items"])
        return items


def print_report(items):
    if not items:
        print("No usage data found.")
        return

    # Group by apiKey, then sort by hourBucket within each key
    by_key = defaultdict(list)
    for item in items:
        by_key[item["apiKey"]].append((item["hourBucket"], int(item["requestCount"])))

    for api_key in sorted(by_key.keys()):
        print(f"\n{api_key}")
        print("-" * len(api_key))
        rows = sorted(by_key[api_key])
        total = 0
        for hour_bucket, count in rows:
            print(f"  {hour_bucket}:00  ->  {count} requests")
            total += count
        print(f"  {'TOTAL':>17}  ->  {total} requests")


def main():
    parser = argparse.ArgumentParser(description="Query RateShield usage data.")
    parser.add_argument("--key", help="Show usage for a single API key only.")
    args = parser.parse_args()

    dynamodb = boto3.resource("dynamodb")
    items = fetch_all_usage(dynamodb, api_key=args.key)
    print_report(items)


if __name__ == "__main__":
    main()