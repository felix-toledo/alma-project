// What the vision model and the house watches are asked, in English whatever the app language (spec 025 BR-17).

export const VISION_SYSTEM =
  'You are Alma’s eyes, a home automation assistant. You look at images (floor plans, photos of rooms, security cameras) and answer exactly what is asked, plainly. If it is hard to see, say so instead of making things up.'

/** The question that turns a floor plan picture into rooms, on a 0–100 grid. */
export const planQuestion = (hint: string): string =>
  `This image is a floor plan, sketch or drawing of a house seen from above. Return ONLY a JSON with the rooms and the doors, with no text around it:
{"rooms":[{"name":"Kitchen","polygon":[[x,y],[x,y],[x,y],[x,y]]}],"doors":[{"a":[x,y],"b":[x,y]}]}
Rules: coordinates as a percentage of the image, from 0 to 100 (x = % of the width to the right, y = % of the height downward), hugging the lines of the drawing; each room is a closed polygon (4 points if it is rectangular); use the name written on the plan, or a reasonable one (Living room, Bedroom, Bathroom…) if there is none, in the language of the plan or of the user's note; rooms must not overlap; doors are segments on the walls. If the image shows a single room, return that single room as a rectangle that fills almost the whole grid.${hint ? `\nNote from the user: ${hint}` : ''}`

export const watchQuestion = (camera: string, condition: string): string =>
  `This is the camera “${camera}”. Is this true now?: “${condition}”. Answer ONLY with a JSON: {"match": true|false, "note": "what you see, in one sentence"}.`

export const cameraQuestion = (camera: string, question: string): string => `Camera “${camera}”. ${question}`

export const DEFAULT_IMAGE_QUESTION = 'Describe what you see, with detail useful for a smart home.'
export const DEFAULT_CAMERA_QUESTION = 'What can be seen? Are there people, animals or anything out of the ordinary?'
