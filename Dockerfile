# The service itself. One process, no build step: Node 26 runs the TypeScript
# directly, so what ships is what was written and there is no compiled artefact
# that can drift from the source.

FROM node:26-trixie-slim

WORKDIR /app

# Dependencies first, in their own layer, so a change to the code does not
# reinstall them. --omit=dev leaves out the connector test client, which must
# never be in the image: a smaller image has less in it to go wrong.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Each of these is copied deliberately, and each is needed at RUN time. The
# scripts are deliberately absent: guards, sizing and the copy-review tool run on
# a developer's machine or the host, and .dockerignore keeps them out.
# src: the service.
COPY src/ ./src/
# migrations: applied by the one-shot migrate container.
COPY migrations/ ./migrations/
# content: the primer and the shell key-setup block, both served to agents, the
# bridge and the skill.
COPY content/ ./content/
# plugin: the Claude Code plugin's own files, zipped with the bridge and the skill
# when the service starts and served at /plugins/schellingaf.zip.
COPY plugin/ ./plugin/
# reference: holds the approval. The service refuses to start without it when
# REQUIRE_APPROVED_COPY is set, which the deployed configuration does.
COPY reference/ ./reference/

# Never root, and yet no USER line: the container starts as root so the entry
# point can give LOG_DIR to the node user, which a volume mounted owned by root
# would otherwise keep from it, and then runs the command as node. Every command
# given to this image, the migration runner's included, runs as node through it;
# one that replaces the entry point says `user: node` itself. A command run beside
# the service with exec starts as root too, so give it `--user node`: a file root
# writes into LOG_DIR is one the service cannot append to.
COPY docker-entrypoint.sh /docker-entrypoint.sh
ENTRYPOINT ["/docker-entrypoint.sh"]

# One request, no shell, so a container that cannot answer is restarted rather
# than sitting there looking alive. To the port the service listens on: PORT,
# when the host sets it, and 3000 otherwise.
HEALTHCHECK --interval=15s --timeout=3s --retries=5 --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "src/server.ts"]
