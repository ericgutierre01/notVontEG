// Escenas del firmware (dp4 scence_id). Ids extraídos de los assets del APK.
export interface Scene { id: number; name: string; }
export interface SceneGroup { title: string; scenes: Scene[]; }

const g = (title: string, list: [string, number][]): SceneGroup =>
  ({ title, scenes: list.map(([name, id]) => ({ id, name })) });

export const SCENE_GROUPS: SceneGroup[] = [
  g('Naturaleza', [['Amanecer', 6], ['Atardecer', 7], ['Aurora', 8], ['Anochecer', 9], ['Resplandor', 10],
    ['Estrellas', 11], ['Relámpago', 12], ['Primavera', 13], ['Verano', 14], ['Otoño', 15], ['Invierno', 16],
    ['Bosque', 17], ['Río', 18]]),
  g('Vida', [['Lectura', 2], ['Romántico', 4], ['Dulce', 30], ['Cita', 31], ['Destellos', 32], ['Deportes', 33],
    ['Juegos', 34], ['Película', 35], ['Estudio', 36], ['Negocios', 37], ['Trabajo', 38], ['Combate', 39]]),
  g('Emoción', [['Vivo', 1], ['Relajado', 3], ['Respirar', 5], ['Feliz', 40], ['Entusiasta', 41], ['Emocionado', 42],
    ['Activo', 43], ['Cálido', 44], ['Tranquilo', 45], ['Profundo', 46], ['Nostalgia', 47], ['Ensueño', 48]]),
  g('Festivos', [['Fiesta', 19], ['Velas', 20], ['Navidad', 21], ['Halloween', 22], ['Fantasma', 23],
    ['San Valentín', 24], ['Día de las Madres', 25], ['Día de los Padres', 26], ['Acción de Gracias', 27],
    ['Fiesta de baile', 28], ['Disco', 29]]),
];

export const PRESET_COLORS = ['#ff3b30', '#ff9500', '#ffcc00', '#a3e635', '#34c759', '#00c7be',
  '#32ade6', '#0a5cff', '#5856d6', '#af52de', '#ff2d92', '#ffffff'];
