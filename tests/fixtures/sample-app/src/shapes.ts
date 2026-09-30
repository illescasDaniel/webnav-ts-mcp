export interface Shape {
	area(): number;
}

export abstract class Polygon implements Shape {
	abstract area(): number;
	describe(): string {
		return `polygon ${this.area()}`;
	}
}

export class Square extends Polygon {
	constructor(private side: number) {
		super();
	}
	area(): number {
		return this.side ** 2;
	}
}

export class Circle implements Shape {
	constructor(private r: number) {}
	area(): number {
		return Math.PI * this.r ** 2;
	}
}

export class Unit<T = number> extends Square {
	constructor(readonly tag?: T) {
		super(1);
	}
}

export function totalArea(shapes: Shape[]): number {
	return shapes.reduce((sum, s) => sum + s.area(), 0);
}

export function report(): string {
	return String(totalArea([new Square(2), new Circle(1)]));
}
