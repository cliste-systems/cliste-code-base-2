-- Hello Cara demo: drop redundant "Hello Cara … I'm Cara" (confusing when spoken quickly).
UPDATE organizations
SET greeting =
  'Hi — you''re through to Hello Cara. I''m your AI assistant, and this call may be recorded and transcribed. How are you keeping today?'
WHERE slug = 'hello-cara-demo';
