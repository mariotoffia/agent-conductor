# Start a session

Open Chat and type **@conductor**, then your request.

Each session runs one CLI, with one model and one effort level. Use `/runtime`, `/model` and `/effort` to change them, and `/cancel` to stop the current turn.

The model and effort you pick are requests. When you set one, the reply says what you asked for beside what the agent reports it is actually running — and calls it a mismatch when the two differ, which happens more often than you would think.

One session runs one turn at a time. Submit again while a turn is running and it is refused rather than allowed to disturb it; `/cancel` is the way out.
