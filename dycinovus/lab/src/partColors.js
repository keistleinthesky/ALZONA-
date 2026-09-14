// Colours shared between the chart and anything else that labels a voice.
// Kept out of the component file so fast-refresh still works there — a module
// exporting both components and constants breaks it.

export const PART_COLORS = {
  soprano: '#f472b6', // pink
  alto: '#a78bfa', // violet
  tenor: '#38bdf8', // sky
  bass: '#34d399', // emerald
}

export const USER_COLOR = '#fbbf24' // amber — deliberately unlike the parts
