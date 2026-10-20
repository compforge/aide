# Aide

English | [简体中文](README.zh-CN.md)

Aide is a self-hosted personal agent that keeps following through on the work you entrust to it. Ask a question, delegate a goal, or set up an ongoing responsibility through the web app or Feishu. Aide keeps track of progress, asks when it needs your decision, and picks up the work as new information arrives.

For example: “Follow this PR until it is merged. Handle review comments, ask me when a decision is needed, and tell me when it lands.” The same task can span multiple attempts and periods of waiting. With Aide running on your server, closing the chat or shutting down your laptop leaves it running.

## What you can ask

- **Get an answer or a small job done.** “Read this project's README and tell me how to run it.” Aide can inspect files and use the CLIs available in its environment.
- **Delegate a goal.** “Follow this PR until it is merged.” Aide keeps the goal, progress, and waiting conditions together so you can return to the same task with new information or a decision.
- **Set up an ongoing responsibility.** “Check project work every morning and tell me about new blockers.” Each round can involve investigation, action, and waiting before the next round begins.
- **Keep track of external changes.** Aide can observe recent Meego requirements assigned to selected people and changes in configured Kubernetes workloads. It can also query GitHub and GitLab PR status and comments. See [connections and observation coverage](docs/connector/README.md) for setup and current limits.

Aide relates new information to your conversations and existing work. Within an existing delegation, it can continue working; when it finds a new opportunity, it can suggest a next step. It stays quiet when there is nothing useful to report.

## Conversations, tasks, and routines

A **conversation** keeps a topic's messages and related work together. Aide's assistant, **Chief**, answers ordinary questions directly and creates or finds work when something needs continued attention. Using a tool does not require creating a task.

- A **task** has a finish line, such as getting a PR merged. It can last minutes or weeks and involve multiple rounds of work and waiting.
- A **routine** is an ongoing responsibility, such as checking for project blockers every morning. Completing one round leaves it waiting for the next.

Creating a task means Aide has accepted the goal; progress and results arrive asynchronously. You can ask about progress, add information, answer a question, or request a pause in the same conversation.

Each conversation also has an optional periodic review, disabled by default. Enable it in the web app to have Chief revisit that topic's progress and possible next steps, once an hour by default. Turning it off stops these reviews; existing tasks, routines, and external observations continue on their own schedules.

## Get started

You need Node.js 22.19 or later to install dependencies. Bun, used to run the service, is included as a dependency.

```sh
git clone https://github.com/compforge/aide.git
cd aide
npm ci
```

Configure model access for Chief and the default work agent, Pi, in `~/.aide/config.yaml`. If you already use Pi, Aide can use its existing model settings and authentication from `~/.pi/agent`. The [configuration guide](docs/configuration.md) covers model providers, credentials, skills, and connections to external systems. Restart Aide after changing the configuration.

Choose the directory Aide should work in and start it:

```sh
AIDE_CWD=/path/to/work AIDE_TIMEZONE=Asia/Shanghai npm start
```

Open <http://127.0.0.1:7433> and try: “Read the README in the working directory and tell me how to run the project.” Make sure the service can access the files, CLIs, and credentials needed for your requests.

In the web app, select a conversation on the left, follow messages and execution progress in the center, and view its tasks and routines on the right. Past execution details remain available after a refresh.

For an always-on Linux setup, proxy settings, or access through an SSH tunnel, see [deployment and troubleshooting](docs/deployment.md).

## Use Feishu

Set `AIDE_FEISHU_APP_ID` and `AIDE_FEISHU_APP_SECRET` to connect your bot. Send it a direct message or @mention it in a group; no public callback endpoint is required. With CardKit permissions enabled, replies and progress appear in a streaming card.

See [Feishu setup](docs/channel/feishu.md) for bot creation and permissions. Text messages are supported in direct chats and group @mentions. Agent permission requests still need to be handled in the web app.

## Before you rely on it

Aide currently serves one user through a single service instance. Its HTTP interface has no authentication, so keep it on a trusted local connection or access it through an SSH tunnel. Conversations group topics; they do not provide account or permission isolation, and long-term memory may be shared across conversations.

State is stored in `~/.aide` by default. The service must remain running to make progress. After a restart, Aide restores saved work and schedules; interrupted actions or results it cannot validate wait for your review before you explicitly continue. Check external effects before retrying. Pausing or deleting work does not undo actions already taken.

Aide uses AI models, which can make mistakes. Review important results against the files, artifacts, or external systems involved.
