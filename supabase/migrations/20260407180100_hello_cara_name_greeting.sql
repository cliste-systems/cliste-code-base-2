-- Hello Cara demo: warmer v3-friendly opening — ask for caller name (no redundant Hello Cara / I'm Cara).
UPDATE organizations
SET greeting =
  'Hey there, you''re through to Cara — can I get your name please?'
WHERE slug = 'hello-cara-demo';
