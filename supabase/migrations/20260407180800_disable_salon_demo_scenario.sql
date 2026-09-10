-- Hello Cara demo: disable salon scenario (unprompted salon talk on demo line).
UPDATE demo_scenarios
SET is_active = false
WHERE slug = 'salon';
