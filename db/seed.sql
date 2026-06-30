-- Seed the 6 original projects so the rebuilt site matches the design immediately.
-- Images are intentionally empty: the originals were "Drop image" placeholders;
-- Alie uploads real images (with subtitles) via /admin. Cards with no images
-- render the diagonal-stripe placeholder, exactly like the original export.

DELETE FROM project_images;
DELETE FROM projects;

INSERT INTO projects (title, kicker, index_label, summary, tags, sort_order, published) VALUES
('PULSE WALL', 'INSTALLATION · 2025', '/01',
 'A 4,096-LED reactive wall driven by live crowd audio. Custom firmware, 60fps shader pipeline, zero perceptible latency.',
 '["FIRMWARE","SHADER PIPELINE","AUDIO DSP","PCB DESIGN"]', 0, 1),

('hello_miami', 'PLATFORM · 2024', '/02',
 'Founded & built the largest tech community in Miami — events platform, member CRM and a city-wide presence.',
 '["FOUNDER","PRODUCT","COMMUNITY","BRAND"]', 1, 1),

('MATRIX LABS', 'R&D STUDIO · 2023', '/03',
 'An experimental studio shipping hardware-software prototypes for brands — from kinetic signage to wearable displays.',
 '["R&D","PROTOTYPING","CLIENT WORK","HARDWARE"]', 2, 1),

('SEVEN SEG', 'TYPE SYSTEM · 2023', '/04',
 'An open-source variable font that emulates seven-segment & dot-matrix displays, used across the work on this site.',
 '["TYPE DESIGN","OPEN SOURCE","TOOLING"]', 3, 1),

('NEON DRIFT', 'KINETIC SCULPTURE · 2024', '/05',
 'A suspended array of motorized RGB rods that drift into evolving 3D forms — choreographed motion synced to a generative light score.',
 '["MOTION CONTROL","STEPPER RIGS","GENERATIVE","FABRICATION"]', 4, 1),

('SIGNAL FM', 'AUDIO-VISUAL · 2022', '/06',
 'A real-time visual system for live shows — spectrum-driven WebGL scenes triggered on the beat and mixed live from a hardware controller.',
 '["WEBGL","AUDIO REACTIVE","LIVE VISUALS","GLSL"]', 5, 1);
