import { describe, expect, it } from "vitest";
import { OverlayGate } from "../src/shared/overlayGate.js";

const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("OverlayGate", () => {
	it("given an exclusive section, when another holder starts, then it waits until the section ends", async () => {
		const gate = new OverlayGate();
		const log: string[] = [];
		const writer = gate.hold(async () => {
			await gate.exclusive(async () => {
				log.push("overlay start");
				await tick(40);
				log.push("overlay end");
			});
		});
		await tick();
		const reader = gate.hold(async () => {
			log.push("read");
		});
		await Promise.all([writer, reader]);
		expect(log).toEqual(["overlay start", "overlay end", "read"]);
	});

	it("given a running holder, when an exclusive section is requested, then it waits for that holder", async () => {
		const gate = new OverlayGate();
		const log: string[] = [];
		const reader = gate.hold(async () => {
			await tick(40);
			log.push("read done");
		});
		await tick();
		const writer = gate.hold(() =>
			gate.exclusive(async () => {
				log.push("overlay");
			}),
		);
		await Promise.all([reader, writer]);
		expect(log).toEqual(["read done", "overlay"]);
	});

	it("given two writers, when both need an overlay, then they run one after the other without deadlock", async () => {
		const gate = new OverlayGate();
		let inside = 0;
		let maxInside = 0;
		const writer = () =>
			gate.hold(() =>
				gate.exclusive(async () => {
					maxInside = Math.max(maxInside, ++inside);
					await tick(15);
					inside--;
				}),
			);
		await Promise.all([writer(), writer(), writer()]);
		expect(maxInside).toBe(1);
	});

	it("given a failing exclusive body, when it throws, then the gate opens again", async () => {
		const gate = new OverlayGate();
		await expect(
			gate.hold(() =>
				gate.exclusive(async () => {
					throw new Error("boom");
				}),
			),
		).rejects.toThrow("boom");
		expect(await gate.hold(async () => "ok")).toBe("ok");
	});
});
