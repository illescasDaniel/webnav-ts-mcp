/**
 * Keeps simulated edits away from everything else.
 *
 * While a write tool shows the language server unsaved text (`LspClient.withOverlay`), no other
 * tool may query that server, or it would answer from text that is not on disk. Every tool call
 * runs as a shared holder; an overlay section is exclusive: it waits for the other holders to
 * finish and holds new ones back until it is done. Exclusive sections queue first-come.
 */
export class OverlayGate {
	private shared = 0;
	private exclusiveActive = false;
	private waiting: (() => void)[] = [];

	private wake(): void {
		const queue = this.waiting;
		this.waiting = [];
		for (const resume of queue) {
			resume();
		}
	}

	private enterShared(): boolean {
		if (this.exclusiveActive) {
			return false;
		}
		this.shared++;
		return true;
	}

	/** Wait until `take()` succeeds; it checks and claims in one synchronous step, so waiters never pass together. */
	private async until(take: () => boolean): Promise<void> {
		while (!take()) {
			await new Promise<void>((resolve) => this.waiting.push(resolve));
		}
	}

	/** Run `body` as a shared holder (a tool call). */
	async hold<T>(body: () => Promise<T>): Promise<T> {
		await this.until(() => this.enterShared());
		try {
			return await body();
		} finally {
			this.shared--;
			this.wake();
		}
	}

	/**
	 * Run `body` alone. Called from inside a shared holder (`holding`): that holder steps aside for
	 * the duration, so it does not wait for itself, and takes its place back afterwards.
	 */
	async exclusive<T>(body: () => Promise<T>, holding = true): Promise<T> {
		if (holding) {
			this.shared--;
			this.wake();
		}
		try {
			await this.until(() => {
				if (this.exclusiveActive || this.shared > 0) {
					return false;
				}
				this.exclusiveActive = true;
				return true;
			});
			try {
				return await body();
			} finally {
				this.exclusiveActive = false;
				this.wake();
			}
		} finally {
			if (holding) {
				await this.until(() => this.enterShared());
			}
		}
	}
}
