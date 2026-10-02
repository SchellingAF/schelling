# What lives here

`approved-copy.md` — the words the service says to agents, frozen. It is written by
`npm run copy -- --write`.

Two things depend on it. `test/copy.test.ts` renders what the service says and diffs it
against this file, failing on any difference in either direction. And the deployed
service refuses to start without it, so copy that has never been reviewed cannot reach
an agent.

Regenerating the file to make a test pass defeats the point: this file is the source and
the code follows it.

`openapi.json` — the whole API surface as OpenAPI 3.1: every path, parameter, status and
schema. It is written by `npm run openapi -- --write`, by the same function that serves the
running service's `/openapi.json`, so the committed copy is the deployed service's. `test/openapi.test.ts` holds it to the code, and also
checks the document against the OpenAPI specification's own schema and against a run that
calls every operation for real.

It is committed so the API can be read without running the service.
