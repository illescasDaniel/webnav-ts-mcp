export function debounce(fn, ms) {
	let t;
	return (...args) => {
		clearTimeout(t);
		t = setTimeout(() => fn(...args), ms);
	};
}

export function showView(id) {
	document.getElementById("view-" + id).hidden = false;
	document.getElementById(`tab-${id}`);
	const row = document.createElement("div");
	row.className = "row row-" + id;
	row.style.setProperty("--row-height", "20px");
	return row;
}

export function wire(onClick) {
	onClick("btn-save", () => {});
	// getElementById("commented-out") is a comment and must be ignored
	return getComputedStyle(document.body).getPropertyValue("--accent");
}
