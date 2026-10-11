# Chrome Web Store Listing — LeetCode to GitHub Backup

> Last Updated: 2026-10-11

## Store Listing

**Extension Name** [REQUIRED]
LeetCode to GitHub Backup

**Short Description** [REQUIRED]
Automatically backs up your accepted LeetCode practice solutions and metadata directly to your own GitHub repository.

**Detailed Description** [REQUIRED]
Automatically back up your accepted LeetCode practice solutions directly into your chosen GitHub repository. Build your personal coding portfolio seamlessly as you solve problems.

Key Features:
- Automatic sync: Submissions with an "Accepted" verdict are immediately queued and uploaded to your GitHub repository.
- Non-intrusive contest guard: Automatically disables itself on contest pages to avoid any interference during competitive programming rounds.
- Smart local queue: Saves all submissions locally before upload, tracks sync status, and provides one-click retries if a network connection drops.
- Conflict-free commits: Compares file versions against your GitHub repository to update existing solutions without creating merge conflicts or duplicate files.
- Historical backfill: Scan your LeetCode history and backup previously accepted solutions with pacing controls and resumption support.
- Standardized directory layout: Organizes solutions into neat folders with zero-padded problem IDs, solution code files, and rich metadata JSON summaries.
- Complete privacy: Operates entirely in your browser with no intermediate servers, tracking, or analytics. Your GitHub token stays on your device.

How to use:
1. Install the extension and open its popup from your Chrome toolbar.
2. Under Settings, provide a GitHub Personal Access Token (Fine-grained token with "Contents: Read & write" access only) and your repository name.
3. Verify your connection with the "Test GitHub Connection" button and save.
4. Solve any LeetCode practice problem as usual. Upon an "Accepted" result, your solution is backed up automatically!

Privacy & Security:
Your GitHub credentials are saved in your browser's private extension storage and are only sent directly to GitHub's official REST API. The extension does not collect, track, or share your data with any third party.

Support:
Submit questions, feature suggestions, or feedback via GitHub Issues.

**Category** [REQUIRED]
Developer Tools

**Single Purpose** [REQUIRED]
Automatically backs up accepted LeetCode practice solutions and metadata to the user's configured GitHub repository.

**Primary Language** [REQUIRED]
English

---

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon [REQUIRED] | 128×128 PNG | ✅ Ready | `icons/icon-128.png` |
| Screenshot 1 [REQUIRED] | 1280×800 or 640×400 | ⬜ Pending capture | `assets/screenshot-queue.png` |
| Screenshot 2 [RECOMMENDED] | 1280×800 or 640×400 | ⬜ Pending capture | `assets/screenshot-settings.png` |
| Screenshot 3 [RECOMMENDED] | 1280×800 or 640×400 | ⬜ Pending capture | `assets/screenshot-backfill.png` |

---

## Permissions Justification

| Permission | Type | Justification |
|---|---|---|
| `storage` | permissions | Used to store the user's repository configuration, local backup queue, sync status, and list of synced submission IDs on the user's local device. |
| `https://leetcode.com/*` | host_permissions | Required to detect accepted submissions and fetch the authenticated user's solution code, language, and problem metadata on leetcode.com. |
| `https://leetcode.cn/*` | host_permissions | Required to detect accepted submissions and fetch the authenticated user's solution code and problem metadata for LeetCode China users. |
| `https://api.github.com/*` | host_permissions | Required to upload solution code files and metadata JSON files directly to the user's configured GitHub repository via the GitHub REST API. |

---

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** No

The extension does not collect, aggregate, or transmit any user data to any external analytics, telemetry, or third-party servers. All data transactions are strictly between the user's local browser, LeetCode (for viewing submission results), and GitHub (for committing files).

| Data Type | Collected? | Transmitted Off-Device? | Purpose | Shared with Third Parties? |
|---|---|---|---|---|
| Authentication info (GitHub Token) | No | Only to `api.github.com` | Authenticating write operations to user's GitHub repo | No |
| Website content (LeetCode solution) | No | Only to `api.github.com` | Backing up code to user's GitHub repo | No |
| All other categories | No | No | N/A | No |

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

---

## Version History

| Version | Date | Changes | Status |
|---|---|---|---|
| 1.0.0 | 2026-10-11 | Initial release with automatic sync, contest guard, local queue, and historical backfill | Draft |
