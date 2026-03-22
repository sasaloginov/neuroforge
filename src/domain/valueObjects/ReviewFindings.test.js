import { ReviewFindings } from './ReviewFindings.js';

describe('ReviewFindings', () => {
  describe('constants', () => {
    it('has correct blocking severities', () => {
      expect(ReviewFindings.BLOCKING_SEVERITIES).toEqual(['CRITICAL', 'MAJOR', 'HIGH']);
    });

    it('has correct non-blocking severities', () => {
      expect(ReviewFindings.NON_BLOCKING_SEVERITIES).toEqual(['MINOR', 'LOW']);
    });
  });

  describe('parse', () => {
    it('parses [SEVERITY] pattern', () => {
      const text = '[CRITICAL] SQL injection in user input\n[MINOR] Missing JSDoc';
      const result = ReviewFindings.parse(text, 'reviewer-security');

      expect(result.findings).toHaveLength(2);
      expect(result.findings[0]).toEqual({ severity: 'CRITICAL', description: 'SQL injection in user input' });
      expect(result.findings[1]).toEqual({ severity: 'MINOR', description: 'Missing JSDoc' });
      expect(result.reviewerRole).toBe('reviewer-security');
    });

    it('parses **SEVERITY**: pattern', () => {
      const text = '**MAJOR**: DDD layer violation\n**LOW**: Variable naming';
      const result = ReviewFindings.parse(text, 'reviewer-architecture');

      expect(result.findings).toHaveLength(2);
      expect(result.findings[0].severity).toBe('MAJOR');
      expect(result.findings[1].severity).toBe('LOW');
    });

    it('parses SEVERITY — description pattern', () => {
      const text = 'HIGH — Missing input validation on /api/tasks endpoint';
      const result = ReviewFindings.parse(text, 'reviewer-security');

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]).toEqual({ severity: 'HIGH', description: 'Missing input validation on /api/tasks endpoint' });
    });

    it('parses severity: VALUE pattern', () => {
      const text = 'Issue found, severity: MAJOR';
      const result = ReviewFindings.parse(text, 'reviewer-business');

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].severity).toBe('MAJOR');
    });

    it('extracts PASS verdict', () => {
      const text = 'All checks passed. PASS\n[MINOR] Consider renaming';
      const result = ReviewFindings.parse(text, 'reviewer-architecture');

      expect(result.verdict).toBe('PASS');
      expect(result.findings).toHaveLength(1);
      expect(result.hasBlockingFindings).toBe(false);
    });

    it('extracts FAIL verdict', () => {
      const text = 'FAIL\n[CRITICAL] Command injection vulnerability';
      const result = ReviewFindings.parse(text, 'reviewer-security');

      expect(result.verdict).toBe('FAIL');
      expect(result.hasBlockingFindings).toBe(true);
    });

    it('creates fallback finding for FAIL with no findings', () => {
      const text = 'The review result is FAIL. The code has issues.';
      const result = ReviewFindings.parse(text, 'reviewer-business');

      expect(result.verdict).toBe('FAIL');
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].severity).toBe('MAJOR');
      expect(result.findings[0].description).toBe('Review failed without specific findings');
    });

    it('returns null verdict when no PASS/FAIL found', () => {
      const text = '[MINOR] Small style issue';
      const result = ReviewFindings.parse(text, 'reviewer-architecture');

      expect(result.verdict).toBeNull();
    });

    it('deduplicates identical findings', () => {
      const text = '[MAJOR] DDD violation\n**MAJOR**: DDD violation';
      const result = ReviewFindings.parse(text, 'reviewer-architecture');

      expect(result.findings).toHaveLength(1);
    });

    it('handles empty response text', () => {
      const result = ReviewFindings.parse('', 'reviewer-security');

      expect(result.findings).toHaveLength(0);
      expect(result.verdict).toBeNull();
      expect(result.hasBlockingFindings).toBe(false);
    });
  });

  describe('getters', () => {
    it('blockingFindings returns only CRITICAL/MAJOR/HIGH', () => {
      const text = '[CRITICAL] Severe bug\n[MINOR] Style nit\n[HIGH] Perf issue';
      const result = ReviewFindings.parse(text, 'reviewer-business');

      expect(result.blockingFindings).toHaveLength(2);
      expect(result.blockingFindings.map(f => f.severity)).toEqual(['CRITICAL', 'HIGH']);
    });

    it('minorFindings returns only MINOR/LOW', () => {
      const text = '[CRITICAL] Severe\n[MINOR] Small\n[LOW] Trivial';
      const result = ReviewFindings.parse(text, 'reviewer-business');

      expect(result.minorFindings).toHaveLength(2);
      expect(result.minorFindings.map(f => f.severity)).toEqual(['MINOR', 'LOW']);
    });
  });

  describe('parseAll', () => {
    it('aggregates findings from multiple reviewer runs', () => {
      const runs = [
        { roleName: 'reviewer-architecture', response: '[MAJOR] Layer violation\n[MINOR] Naming' },
        { roleName: 'reviewer-security', response: '[CRITICAL] SQL injection\nPASS' },
        { roleName: 'reviewer-business', response: '[LOW] Missing edge case\nPASS' },
      ];

      const result = ReviewFindings.parseAll(runs);

      expect(result.allFindings).toHaveLength(4);
      expect(result.blockingFindings).toHaveLength(2);
      expect(result.minorFindings).toHaveLength(2);
      expect(result.hasBlockingIssues).toBe(true);
      expect(result.reviewersWithBlockingIssues).toEqual(
        expect.arrayContaining(['reviewer-architecture', 'reviewer-security']),
      );
      expect(result.reviewersWithBlockingIssues).not.toContain('reviewer-business');
    });

    it('returns no blocking issues when all findings are minor', () => {
      const runs = [
        { roleName: 'reviewer-architecture', response: '[MINOR] Small style issue\nPASS' },
        { roleName: 'reviewer-business', response: 'PASS' },
      ];

      const result = ReviewFindings.parseAll(runs);

      expect(result.hasBlockingIssues).toBe(false);
      expect(result.reviewersWithBlockingIssues).toHaveLength(0);
      expect(result.minorFindings).toHaveLength(1);
    });
  });
});
