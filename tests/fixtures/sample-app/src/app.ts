export interface Options {
	title: string;
}

export class Base {
	greet(name: string): string {
		return `hello ${name}`;
	}
}

export class Widget extends Base {
	private opts: Options;
	constructor(opts: Options) {
		super();
		this.opts = opts;
	}
	render(): HTMLElement {
		const el = document.getElementById("main-panel");
		el?.classList.add("widget", "is-active");
		document.querySelector<HTMLElement>(".widget .title");
		return el as HTMLElement;
	}
}

export function makeWidget(title: string): Widget {
	return new Widget({ title });
}

// non-BMP + accents before the identifier: columns are UTF-16 offsets
export const label = "héllo 😀";
export const afterEmoji = 1;
