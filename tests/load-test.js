import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const allowedCount = new Counter('allowed_requests');
const deniedCount = new Counter('denied_requests');
const errorCount = new Counter('error_requests');
const authLatency = new Trend('auth_latency', true);

export const options = {
  scenarios: {
    ramping_load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '20s', target: 20 },   // ramp up to 20 concurrent users
        { duration: '40s', target: 50 },   // ramp up to 50
        { duration: '30s', target: 50 },   // hold at 50 (sustained load)
        { duration: '10s', target: 0 },    // ramp down
      ],
    },
  },
};

const API_URL = 'https://8cqodx03j9.execute-api.us-east-1.amazonaws.com/prod/ping';

// Mix of keys across tiers, so the test reflects realistic multi-client traffic
const KEYS = ['free-key-1', 'pro-key-1', 'enterprise-key-1'];

export default function () {
  const apiKey = KEYS[Math.floor(Math.random() * KEYS.length)];

  const res = http.get(API_URL, {
    headers: { 'x-api-key': apiKey },
  });

  authLatency.add(res.timings.duration);

  if (res.status === 200) {
    allowedCount.add(1);
  } else if (res.status === 403 || res.status === 429) {
    deniedCount.add(1);
  } else {
    errorCount.add(1);
    console.log(`Unexpected status: ${res.status}`);
  }

  check(res, {
    'status is 200, 403, or 429': (r) => [200, 403, 429].includes(r.status),
  });
}