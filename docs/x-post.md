# X post drafts (DRAFT)

**Status: DRAFT. Nothing here has been posted.** The human writes, edits and publishes the final post and gives us the link. Agents never post.

Rules from `docs/HACKATHON.md` (Procedure, step 2):

- Say the project was built at NEAR HACKATHON.
- Include `@NEARProtocol` and `#NEARHackathon`. `@NearLegion` and `@NearBuilders` are optional.
- Attach the demo video or screenshots. A video is needed when judges cannot open a hosted demo (Q-012).
- First line makes sense to someone who has not heard of the project.
- Say what NEAR does in the product. Link the repo. Ask one real question.

Each draft is under 280 characters. Counts below are for the text with the placeholder links counted as 23 characters each (how X counts a link). Replace `<REPO_URL>` before posting. Do not claim live testnet results until a live run has actually shown them (`bash scripts/verify.sh` skips live stages by default).

## Draft 1: the problem first

```
AI characters lose their memory when you switch apps. These NFTs carry theirs: transfer the token and the character, log and reputation go with it. Built at NEAR HACKATHON, @NEARProtocol #NEARHackathon. Repo: <REPO_URL> What should an agent remember?
```

- Media: 60 to 90 second screen recording of the demo script (`docs/demo-script.md`), cut to scenes 3 to 6.
- NEAR's role: the NFT (NEP-171) holds the sheet hash, so a new owner can check the sheet they received.

## Draft 2: the one moment

```
4 AI agents, 4 NFTs, one shared channel. After 5 rounds each agent's character sheet changes, and its hash is stored on its token. Run it with no API key. Built at NEAR HACKATHON, @NEARProtocol #NEARHackathon. Code: <REPO_URL> Which part would you try to break?
```

- Media: terminal recording of the swarm transcript followed by the sheet diff (scenes 4 and 5).
- NEAR's role: NEAR AI Cloud answers each agent's turn; the token stores the proof of the latest sheet.

## Draft 3: for builders

```
Hackathon build: personality NFTs on NEAR testnet. NEP-171 token, NEAR AI Cloud for inference, mock mode so anyone can fork and run it without keys. Built at NEAR HACKATHON. @NEARProtocol #NEARHackathon <REPO_URL> Feedback on the contract welcome.
```

- Media: screenshot of the four SVG avatars under `out/` plus a screenshot of `bash scripts/verify.sh` showing `result: PASS`.
- NEAR's role: contract on testnet plus NEAR AI Cloud, both named in the README.

## Before the human posts

- [ ] Pick one draft and edit it into their own voice.
- [ ] Replace `<REPO_URL>`. The repository must be public first.
- [ ] Attach the video or screenshots.
- [ ] Confirm every claim in the text matches what the demo shows.
- [ ] Publish, copy the post URL, and give it to the agent. That URL is `demoUrl` in the submission.
