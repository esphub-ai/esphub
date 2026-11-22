ALTER TABLE esphub.devices DROP CONSTRAINT devices_board_check,
    ADD CONSTRAINT devices_board_check CHECK (board IN ('paper-color', 'stopwatch', 'cardputer-adv'));
