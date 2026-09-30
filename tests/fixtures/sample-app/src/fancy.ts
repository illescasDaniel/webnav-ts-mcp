import { totalArea, Unit } from "./shapes.ts";
import { Widget } from "./app.ts";

export class FancyWidget extends Widget {
	shine(): number {
		return totalArea([new Unit()]);
	}
}

export function shineAll(widgets: FancyWidget[]): number {
	return widgets.reduce((sum, w) => sum + w.shine(), 0);
}
