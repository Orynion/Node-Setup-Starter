---
name: GitHub sync in this workspace
description: Durable guidance for reconciling GitHub API writes with local Git tracking when direct Git HTTPS auth is unavailable.
---

When direct Git HTTPS authentication fails but the connected GitHub integration is available, perform repository writes through the integration and reconcile local refs against the verified GitHub tip rather than force-pushing or requesting credentials.

**Why:** This workspace can authenticate GitHub API requests through Replit while rejecting direct Git remote authentication; leaving local tracking refs stale causes false push-rejection states even when the remote already contains the intended tree.

**How to apply:** Verify the remote commit/tree and file blob through the connected integration, ensure the local tree matches, then update local tracking refs only to the verified remote commit. Preserve unrelated working-tree changes.