UPDATE libraries SET
  render_skip_full = trim(replace(',' || render_skip_full || ',', ',match,', ',lens,colour,'), ','),
  render_skip_max = trim(replace(',' || render_skip_max || ',', ',match,', ',lens,colour,'), ',');
