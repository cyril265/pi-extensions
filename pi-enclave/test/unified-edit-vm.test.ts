import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RealFSProvider, VM } from "@earendil-works/gondolin";
import { expect, test } from "vitest";
import { createVmUnifiedEditOps } from "../src/tools.js";
import registerUnifiedEdit from "../src/unified-edit.js";

const runVmTest = process.env.PI_ENCLAVE_VM_TEST === "1" ? test : test.skip;

runVmTest(
	"applies unified patches through a real Gondolin VM",
	async () => {
		const cwd = await mkdtemp("/tmp/pi-enclave-unified-edit-");
		await writeFile(join(cwd, "source.txt"), "old\n", "utf8");

		const qemuPath = process.arch === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86_64";
		const vm = await VM.create({
			sandbox: { qemuPath },
			vfs: { mounts: { [cwd]: new RealFSProvider(cwd) } },
		});

		let editTool:
			| {
					execute(
						id: string,
						params: { text: string },
						signal: undefined,
						onUpdate: undefined,
						ctx: { cwd: string },
					): Promise<unknown>;
			  }
			| undefined;

		registerUnifiedEdit(
			{
				on() {},
				registerTool(tool: unknown) {
					editTool = tool as typeof editTool;
				},
			} as never,
			async () => createVmUnifiedEditOps(vm),
		);

		try {
			if (!editTool) throw new Error("Unified edit tool was not registered.");
			await editTool.execute(
				"vm-edit",
				{
					text: `*** Begin Patch
*** Update File: source.txt
*** Move to: moved.txt
@@
-old
+new
*** Add File: added.txt
+created
*** End Patch`,
				},
				undefined,
				undefined,
				{ cwd },
			);

			await expect(readFile(join(cwd, "moved.txt"), "utf8")).resolves.toBe("new\n");
			await expect(readFile(join(cwd, "added.txt"), "utf8")).resolves.toBe("created\n");
			await expect(readFile(join(cwd, "source.txt"), "utf8")).rejects.toThrow();

			await editTool.execute(
				"vm-delete",
				{ text: "*** Begin Patch\n*** Delete File: added.txt\n*** End Patch" },
				undefined,
				undefined,
				{ cwd },
			);
			await expect(readFile(join(cwd, "added.txt"), "utf8")).rejects.toThrow();
		} finally {
			await vm.close();
			await rm(cwd, { recursive: true, force: true });
		}
	},
	120_000,
);
