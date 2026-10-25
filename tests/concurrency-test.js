import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const allowedCount = new Counter('allowed_requests');
const deniedCount = new Counter('denied_requests');
const errorCount = new Counter('error_requests');

export const options = {
  scenarios: {
    burst: {
      executor: 'shared-iterations',
      vus: 50,
      iterations: 50,
      maxDuration: '15s',
    },
  },
};

const API_URL = 'https://8cqodx03j9.execute-api.us-east-1.amazonaws.com/prod/ping';
const API_KEY = 'enterprise-key-1'; // capacity 50, split across 5 shards of 10 each

export default function () {
  const res = http.get(API_URL, {
    headers: { 'x-api-key': API_KEY },
  });

  if (res.status === 200) {
    allowedCount.add(1);
  } else if (res.status === 403) {
    deniedCount.add(1);
  } else {
    errorCount.add(1);
    console.log(`Unexpected status: ${res.status}, body: ${res.body}`);
  }

  check(res, {
    'status is 200 or 403': (r) => r.status === 200 || r.status === 403,
  });
}