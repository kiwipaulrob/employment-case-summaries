-- Migration 0016: Add reinstatement_sought, employee_status columns to case_awards
-- These support three-state reinstatement display and employee/contractor status tracking.

ALTER TABLE case_awards ADD COLUMN reinstatement_sought INTEGER NOT NULL DEFAULT 0;
ALTER TABLE case_awards ADD COLUMN employee_status INTEGER NOT NULL DEFAULT 0;
