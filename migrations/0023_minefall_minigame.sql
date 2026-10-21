-- Enable the 'minefall' falling pickaxe minigame in minigame_rounds.
ALTER TABLE minigame_rounds DROP CONSTRAINT IF EXISTS minigame_rounds_game_check;
ALTER TABLE minigame_rounds ADD CONSTRAINT minigame_rounds_game_check CHECK (game IN ('lucky_chest', 'minesweeper', 'minefall'));
