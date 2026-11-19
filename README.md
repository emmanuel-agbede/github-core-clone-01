# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/emmanuel-agbede/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/emmanuel-agbede/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge written from scratch on the Node.js standard library alone — no dependencies, no git binary. One in-memory store backs four surfaces: git smart HTTP (protocol v2 ls-refs and fetch with shallow/deepen support, v0 fallback, receive-pack with report-status in side-band-64k, real SHA-1 object model and packfiles), the REST v3 API (repositories, contents, branches, refs, commits, labels, issues, comments, pull requests with file diffs and squash merges), the GraphQL v4 API (the documents gh and github-mcp-server send, Relay global ids, cursor pagination, batching, __type introspection), and an MCP endpoint (streamable HTTP, tools that act on the same store as REST). Server-minted commits use deterministic timestamps in request order, so a replayed trial produces byte-identical objects.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=eg1d3bmd&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
