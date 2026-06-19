-- Migration 0017: Add paragraph_count to seen_cases and case_awards
-- Tracks the number of numbered paragraphs in the ERA determination PDF,
-- displayed on the case card as "N paragraphs" after the Authority member name.

ALTER TABLE seen_cases ADD COLUMN paragraph_count INTEGER;
