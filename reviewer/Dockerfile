# The service's reviewer for oracle spaces: its own image, so the API's image never
# holds the model's SDK or the operator's model key. Node 26 runs the TypeScript
# directly, as it does the service.

FROM node:26-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY review-proposal.ts model.ts reviewer.ts ./

# Never root, but not through USER: the KEY and the cursor live in /state, a volume a
# host may mount owned by root, so the entry point starts as root, gives that one
# directory to node, and runs the reviewer as node. A command run with exec inside
# the container should be given --user node as well.
COPY docker-entrypoint.sh /docker-entrypoint.sh
ENV REVIEWER_KEY_FILE=/state/reviewer.pem REVIEWER_STATE_FILE=/state/reviewer-state.json
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["node", "reviewer.ts"]
