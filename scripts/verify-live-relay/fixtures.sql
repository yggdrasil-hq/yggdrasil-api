-- Fixtures for the live-relay fan-out verification (issue #32).
--
-- Fixed UUIDs so the Node verifier can name them without a round trip, and so a
-- failed run's leftovers are identifiable. Everything here is what
-- `authorizeSubscription` and the internal event routes actually require:
-- a session (the socket's only credential), an org membership (the project gate
-- joins `organization_memberships`), a project owned by that user, a feature
-- inside it, and a job (the delta path reads the job row to learn the feature).
INSERT INTO users (id, username, display_name, github_id, github_login, onboarding_state)
VALUES (
  '11111111-1111-4111-8111-111111111111',
  'relay-verifier', 'Relay Verifier', 990001, 'relay-verifier', 'active'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO organizations (id, name, slug, is_personal, status)
VALUES (
  '22222222-2222-4222-8222-222222222222',
  'Relay Verify Org', 'relay-verify-org', false, 'ready'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO organization_memberships (organization_id, user_id, role)
VALUES (
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  'admin'
) ON CONFLICT (organization_id, user_id) DO NOTHING;

INSERT INTO projects (id, owner_user_id, organization_id, name, slug, status)
VALUES (
  '33333333-3333-4333-8333-333333333333',
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  'Relay Verify Project', 'relay-verify-project', 'ready'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO features (id, project_id, title, slug, feature_type, status)
VALUES (
  '44444444-4444-4444-8444-444444444444',
  '33333333-3333-4333-8333-333333333333',
  'Relay Verify Feature', 'relay-verify-feature', 'normal', 'running'
) ON CONFLICT (id) DO NOTHING;

-- A job whose feature_id is set: the delta path derives its routing scope from
-- this row rather than from the request body, so it has to exist.
INSERT INTO jobs (id, project_id, feature_id, kind, status)
VALUES (
  '55555555-5555-4555-8555-555555555555',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
  'spec_grill', 'running'
) ON CONFLICT (id) DO NOTHING;

-- Issue #25: a `design_grill` job, which is the one kind with a topic of its own.
-- No `feature_id`, deliberately: that is what makes it unroutable by the feature
-- topic and is the whole reason the design topic had to exist. `design_slug` is
-- left NULL so the route's "snapshot path inside the design folder" check is a
-- no-op — this fixture is about the relay's routing, not that rule.
INSERT INTO jobs (id, project_id, feature_id, kind, status)
VALUES (
  '77777777-7777-4777-8777-777777777777',
  '33333333-3333-4333-8333-333333333333',
  NULL,
  'design_grill', 'running'
) ON CONFLICT (id) DO NOTHING;

-- Issue #90 / #100: a `tests` row. The `test:` scope needs one for its authoriser to
-- resolve, and both `test_run` shapes below point at it — including the
-- feature-driven one, which is why it is also the *second* destination of a job that
-- already has a feature.
INSERT INTO tests (id, project_id, name, spec_markdown, schedule_cron)
VALUES (
  '99999999-9999-4999-8999-999999999999',
  '33333333-3333-4333-8333-333333333333',
  'Relay Verify Test', '# relay verify fixture', '* * * * *'
) ON CONFLICT (id) DO NOTHING;

-- Issue #90: a scheduled `test_run` — a `test_id` and **no** `feature_id`. That
-- absence is the whole reason the `test:` topic had to exist, because a
-- feature-less job could not be routed by the feature topic at all.
INSERT INTO jobs (id, project_id, feature_id, test_id, kind, status, trigger_source)
VALUES (
  '88888888-8888-4888-8888-888888888888',
  '33333333-3333-4333-8333-333333333333',
  NULL,
  '99999999-9999-4999-8999-999999999999',
  'test_run', 'running', 'schedule'
) ON CONFLICT (id) DO NOTHING;

-- Issue #100: a **feature-driven** `test_run` — both a `feature_id` and a
-- `test_id`. One job with two surfaces: the feature it was dispatched for, and the
-- Test entity whose history lists it. It is the fixture the fan-out check writes
-- to, and the reason one event must arrive on two topics.
INSERT INTO jobs (id, project_id, feature_id, test_id, kind, status)
VALUES (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
  '99999999-9999-4999-8999-999999999999',
  'test_run', 'running'
) ON CONFLICT (id) DO NOTHING;

-- The session id *is* the cookie value (the relay reads an opaque id off the raw
-- Cookie header and calls findValid on it — there is no signature), so the
-- verifier can authenticate by sending this literal.
INSERT INTO sessions (id, user_id, remember_me, expires_at)
VALUES (
  '66666666-6666-4666-8666-666666666666',
  '11111111-1111-4111-8111-111111111111',
  true,
  NOW() + INTERVAL '1 day'
) ON CONFLICT (id) DO NOTHING;
