/**
 * Tests for src/rate-limiter.ts — in-memory sliding window rate limiter.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { checkRateLimit, getClientIp, resetRateLimiter } from '../src/rate-limiter';

describe('checkRateLimit', () => {
  beforeEach(() => {
    resetRateLimiter();
  });

  it('allows the first request from an IP', () => {
    expect(checkRateLimit('1.2.3.4', 5, 60_000)).toBe(true);
  });

  it('allows requests within the limit', () => {
    const ip = '1.2.3.4';
    for (let i = 0; i < 5; i++) {
      expect(checkRateLimit(ip, 5, 60_000)).toBe(true);
    }
  });

  it('blocks requests exceeding the limit', () => {
    const ip = '1.2.3.4';
    for (let i = 0; i < 5; i++) {
      checkRateLimit(ip, 5, 60_000);
    }
    // 6th request should be blocked
    expect(checkRateLimit(ip, 5, 60_000)).toBe(false);
  });

  it('tracks different IPs independently', () => {
    const ipA = '1.2.3.4';
    const ipB = '5.6.7.8';

    for (let i = 0; i < 10; i++) {
      checkRateLimit(ipA, 10, 60_000);
    }

    // ipA should be at limit
    expect(checkRateLimit(ipA, 10, 60_000)).toBe(false);
    // ipB should still be allowed
    expect(checkRateLimit(ipB, 10, 60_000)).toBe(true);
  });

  it('resets after the window expires', async () => {
    const ip = '1.2.3.4';
    // Use a very short window
    for (let i = 0; i < 3; i++) {
      checkRateLimit(ip, 3, 50); // 3 requests in 50ms
    }
    expect(checkRateLimit(ip, 3, 50)).toBe(false);

    // Wait for window to expire
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(checkRateLimit(ip, 3, 50)).toBe(true);
  });

  it('uses default limits when not specified', () => {
    const ip = '1.2.3.4';
    // Default is 20 requests in 60s
    for (let i = 0; i < 20; i++) {
      checkRateLimit(ip);
    }
    expect(checkRateLimit(ip)).toBe(false);
  });
});

describe('getClientIp', () => {
  it('extracts CF-Connecting-IP when available', () => {
    const request = new Request('https://example.com', {
      headers: { 'CF-Connecting-IP': '203.0.113.1' },
    });
    expect(getClientIp(request)).toBe('203.0.113.1');
  });

  it('falls back to x-forwarded-for', () => {
    const request = new Request('https://example.com', {
      headers: { 'x-forwarded-for': '198.51.100.1, 10.0.0.1' },
    });
    expect(getClientIp(request)).toBe('198.51.100.1');
  });

  it('returns "unknown" when no IP headers present', () => {
    const request = new Request('https://example.com');
    expect(getClientIp(request)).toBe('unknown');
  });

  it('prefers CF-Connecting-IP over x-forwarded-for', () => {
    const request = new Request('https://example.com', {
      headers: {
        'CF-Connecting-IP': '203.0.113.1',
        'x-forwarded-for': '198.51.100.1',
      },
    });
    expect(getClientIp(request)).toBe('203.0.113.1');
  });
});

describe('resetRateLimiter', () => {
  it('clears all stored IPs', () => {
    checkRateLimit('1.2.3.4', 1, 60_000);
    expect(checkRateLimit('1.2.3.4', 1, 60_000)).toBe(false);

    resetRateLimiter();
    expect(checkRateLimit('1.2.3.4', 1, 60_000)).toBe(true);
  });
});
