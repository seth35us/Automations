#!/usr/bin/env node

const { spawn } = require("node:child_process");
const path = require("node:path");

function parseArgs(argv) {
    const options = {
        dryRun: false,
        headed: false,
        date: null,
        time: null,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--dry-run") options.dryRun = true;
        else if (arg === "--headed") options.headed = true;
        else if (arg === "--date") options.date = argv[++index];
        else if (arg === "--time") options.time = argv[++index];
        else if (arg === "--help") options.help = true;
        else if (arg === "--") continue;
        else {
            const message = arg.replace(/\s+/g, " ").trim();
            if (message) options.request = message;
        }
    }

    return options;
}

function buildCommand(options) {
    const args = ["./run-reservation.sh"];
    if (options.dryRun) args.push("--dry-run");
    if (options.headed) args.push("--headed");
    if (options.date) args.push("--date", options.date);
    if (options.time) args.push("--time", options.time);
    return args;
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log("Usage: ./ask-reservation.cjs [--dry-run] [--headed] [--date YYYY-MM-DD] [--time HH:MM AM/PM] [natural language request]");
        return;
    }

    if (!options.request && !options.date && !options.time && !options.dryRun && !options.headed) {
        console.log("Provide a natural-language request, such as: reserve a court for Saturday at 8:00 AM");
        process.exit(1);
    }

    const command = buildCommand(options);
    const child = spawn(command[0], command.slice(1), {
        cwd: __dirname,
        stdio: "inherit",
        shell: false,
    });

    child.on("exit", (code) => {
        process.exit(code ?? 0);
    });
}

main();
