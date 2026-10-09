import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ACTIVE_STATUSES, atomicWriteJson, createJobId, ensurePrivateDirectory, jobPaths, readJson } from "./store.mjs";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_RUNNER = join(MODULE_DIR, "runner.mjs");

function shell(command, args, timeout = 10_000) {
	const result = spawnSync(command, args, { encoding: "utf8", timeout });
	return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
}

function nodePath() {
	if (process.env.PI_JOBS_NODE) return resolve(process.env.PI_JOBS_NODE);
	const result = shell("/usr/bin/env", ["sh", "-c", "command -v node"]);
	if (result.code === 0 && result.stdout.trim().startsWith("/")) return resolve(result.stdout.trim());
	throw new Error("Node.js executable not found; set PI_JOBS_NODE to its absolute path");
}

function environment() {
	return Object.fromEntries(["HOME", "PATH", "SHELL", "LANG", "LC_ALL", "TMPDIR", "USER", "LOGNAME"]
		.map((key) => [key, process.env[key]])
		.filter(([, value]) => typeof value === "string" && value.length));
}

function xml(value) {
	return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function plist(config, paths, executable, runnerPath) {
	const env = Object.entries(environment()).map(([key, value]) => `      <key>${xml(key)}</key>\n      <string>${xml(value)}</string>`).join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(config.serviceName)}</string>
  <key>ProgramArguments</key><array>
    <string>${xml(executable)}</string><string>${xml(runnerPath)}</string>
    <string>--config</string><string>${xml(join(paths.directory, "config.json"))}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>ExitTimeOut</key><integer>2</integer>
  <key>Umask</key><integer>63</integer>
  <key>WorkingDirectory</key><string>${xml(config.cwd)}</string>
  <key>StandardOutPath</key><string>${xml(paths.runnerStdoutPath)}</string>
  <key>StandardErrorPath</key><string>${xml(paths.runnerStderrPath)}</string>
  <key>EnvironmentVariables</key><dict>
${env}
  </dict>
</dict></plist>
`;
}

export class ServiceManager {
	constructor({ sessionId, sessionDirectory, runnerPath = DEFAULT_RUNNER, executable = nodePath() }) {
		this.sessionId = sessionId;
		this.sessionDirectory = sessionDirectory;
		this.runnerPath = resolve(runnerPath);
		this.executable = executable;
		this.backend = process.platform === "darwin" ? "launchd" : process.platform === "linux" ? "systemd" : "detached";
	}

	start(spec, parentId) {
		const id = createJobId();
		const paths = jobPaths(this.sessionDirectory, id);
		ensurePrivateDirectory(paths.directory);
		const createdAt = Date.now();
		const serviceName = "dev.pi.jobs." + this.sessionId.replace(/[^A-Za-z0-9.-]/g, "-").slice(0, 28) + "." + id;
		const timeoutMs = Math.max(1_000, Number(spec.timeoutMs) || 86_400_000);
		const capturedEnvironment = { ...process.env };
		delete capturedEnvironment.PI_SESSION_ID;
		delete capturedEnvironment.PI_SESSION_FILE;
		const config = {
			version: 1,
			id,
			parentId,
			sessionId: this.sessionId,
			sessionDirectory: this.sessionDirectory,
			serviceName,
			backend: this.backend,
			label: spec.label?.trim() || "command",
			command: spec.command.trim(),
			cwd: resolve(spec.cwd),
			timeoutMs,
			terminateTurn: spec.terminateTurn !== false,
			createdAt,
			ownerPid: process.pid,
		};
		atomicWriteJson(join(paths.directory, "config.json"), config);
		atomicWriteJson(paths.envPath, capturedEnvironment);
		atomicWriteJson(paths.statePath, {
			version: 1,
			id,
			parentId,
			label: config.label,
			status: "queued",
			command: config.command,
			cwd: config.cwd,
			timeoutMs,
			terminateTurn: config.terminateTurn,
			ownerPid: config.ownerPid,
			createdAt,
			deadlineAt: createdAt + timeoutMs,
			eventSeq: 0,
		});
		atomicWriteJson(paths.controlPath, { version: 1, backend: this.backend, serviceName, createdAt });
		try {
			if (this.backend === "launchd") this.#startLaunchd(config, paths);
			else if (this.backend === "systemd") this.#startSystemd(config, paths);
			else this.#startDetached(config, paths);
		} catch (error) {
			try { rmSync(paths.directory, { recursive: true, force: true }); } catch {}
			throw error;
		}
		return id;
	}

	#startLaunchd(config, paths) {
		writeFileSync(paths.servicePath, plist(config, paths, this.executable, this.runnerPath), { mode: 0o600 });
		chmodSync(paths.servicePath, 0o600);
		const domain = "gui/" + process.getuid();
		const result = shell("/bin/launchctl", ["bootstrap", domain, paths.servicePath]);
		if (result.code !== 0) throw new Error("launchctl bootstrap failed: " + (result.stderr || result.error || result.code));
	}

	#startSystemd(config, paths) {
		if (shell("/usr/bin/env", ["sh", "-c", "command -v systemd-run >/dev/null && systemctl --user show-environment >/dev/null"]).code !== 0) {
			this.backend = "detached";
			config.backend = "detached";
			atomicWriteJson(join(paths.directory, "config.json"), config);
			atomicWriteJson(paths.controlPath, { version: 1, backend: "detached", serviceName: config.serviceName, createdAt: config.createdAt });
			return this.#startDetached(config, paths);
		}
		const args = ["--user", "--unit", config.serviceName, "--collect", "--property=KillMode=control-group", "--property=TimeoutStopSec=2s"];
		for (const [key, value] of Object.entries(environment())) args.push("--setenv=" + key + "=" + value);
		args.push(this.executable, this.runnerPath, "--config", join(paths.directory, "config.json"));
		const result = shell("systemd-run", args);
		if (result.code !== 0) throw new Error("systemd-run failed: " + (result.stderr || result.error || result.code));
	}

	#startDetached(config, paths) {
		const out = openSync(paths.runnerStdoutPath, "a", 0o600);
		const err = openSync(paths.runnerStderrPath, "a", 0o600);
		const child = spawn(this.executable, [this.runnerPath, "--config", join(paths.directory, "config.json")], {
			cwd: config.cwd,
			env: process.env,
			stdio: ["ignore", out, err],
			detached: true,
		});
		child.unref();
		atomicWriteJson(paths.controlPath, { version: 1, backend: "detached", serviceName: config.serviceName, runnerPid: child.pid, createdAt: config.createdAt });
	}

	stop(id) {
		const paths = jobPaths(this.sessionDirectory, id);
		const control = readControl(paths.controlPath);
		if (!control) return false;
		let stopped = false;
		if (control.backend === "launchd") {
			const result = shell("/bin/launchctl", ["bootout", "gui/" + process.getuid() + "/" + control.serviceName]);
			stopped = result.code === 0 || /could not find service|no such process/i.test(result.stderr);
		} else if (control.backend === "systemd") {
			const result = shell("systemctl", ["--user", "stop", control.serviceName]);
			stopped = result.code === 0 || /not loaded|not found|does not exist/i.test(result.stderr);
		} else {
			const pid = Number(control.runnerPid);
			if (pid) {
				try { process.kill(pid, "SIGTERM"); stopped = true; } catch {}
			}
		}
		if (stopped) this.#recordStopped(paths.statePath);
		return stopped;
	}

	#recordStopped(statePath) {
		const state = readJson(statePath, undefined);
		if (!state || !ACTIVE_STATUSES.has(state.status)) return;
		atomicWriteJson(statePath, {
			...state,
			status: "stopped",
			finishedAt: Date.now(),
			pid: undefined,
			eventSeq: (state.eventSeq ?? 0) + 1,
		});
	}

	release(id) {
		const paths = jobPaths(this.sessionDirectory, id);
		if (existsSync(paths.releasedPath)) return true;
		const control = readControl(paths.controlPath);
		if (!control) return false;
		let released = true;
		if (control.backend === "launchd") {
			const target = "gui/" + process.getuid() + "/" + control.serviceName;
			const result = shell("/bin/launchctl", ["bootout", target]);
			released = result.code === 0 || /could not find service|no such process/i.test(result.stderr);
		} else if (control.backend === "systemd") {
			const result = shell("systemctl", ["--user", "reset-failed", control.serviceName]);
			released = result.code === 0;
		}
		if (released) writeFileSync(paths.releasedPath, "released\n", { mode: 0o600 });
		return released;
	}

	remove(id) {
		const paths = jobPaths(this.sessionDirectory, id);
		this.release(id);
		try { rmSync(paths.directory, { recursive: true, force: true }); return true; } catch { return false; }
	}
}

function readControl(path) {
	try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}
