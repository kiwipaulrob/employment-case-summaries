import { describe, it, expect } from 'vitest';
import { buildFtsQuery } from '../src/db';

describe('buildFtsQuery', () => {
  it('builds a prefix AND query from plain terms', () => {
    expect(buildFtsQuery('redundan')).toBe('redundan*');
    expect(buildFtsQuery('unjustified dismissal')).toBe('unjustified* AND dismissal*');
  });

  it('scopes to a named field when provided', () => {
    expect(buildFtsQuery('smith', 'member')).toBe('member:smith*');
    expect(buildFtsQuery('redundan', 'legal_issues')).toBe('legal_issues:redundan*');
    expect(buildFtsQuery('salary', 'parties')).toBe('parties:salary*');
  });

  it('ignores unknown fields (searches all)', () => {
    expect(buildFtsQuery('foo', 'not_a_field')).toBe('foo*');
  });

  it('strips FTS5 syntax-injecting characters', () => {
    // Quotes, parens, colons, asterisks would otherwise inject FTS5 grammar
    expect(buildFtsQuery('"redundan"')).toBe('redundan*');
    expect(buildFtsQuery('a:b (c) *d*')).toBe('ab* AND c* AND d*');
    expect(buildFtsQuery('title:foo')).toBe('titlefoo*');
    // Control chars / symbols are stripped too
    expect(buildFtsQuery('dismissal — redundancy')).toBe('dismissal* AND redundancy*');
  });

  it('returns empty string for queries with no searchable content', () => {
    expect(buildFtsQuery('   ')).toBe('');
    expect(buildFtsQuery('***')).toBe('');
    expect(buildFtsQuery('')).toBe('');
  });

  it('handles unicode letters', () => {
    expect(buildFtsQuery('māori')).toBe('māori*');
  });
});
