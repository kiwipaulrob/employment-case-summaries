-- Migration: 0003_add_pdf_url.sql
-- Adds pdf_url column to seen_cases table.
-- Enables the digest email to link directly to the case PDF.

ALTER TABLE seen_cases ADD COLUMN pdf_url TEXT;
