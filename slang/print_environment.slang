module print_environment;

static const float ROOM_LOW = 0.05;
static const float ROOM_HORIZON = 0.1;
static const float ROOM_CEILING = 0.5;

/// The room the print hangs in, as radiance against the sine of the elevation looked along, in
/// shares of the ceiling's own.
///
/// **A room is not an integrating sphere, and the difference is most of a print's black.** Ambient
/// light reaches a picture on a wall from the ceiling and the luminaires in it; the wall opposite,
/// the floor and the reader standing in front of it are an order of magnitude darker. A surround of
/// one radiance puts the room's whole illuminance in the direction a reader's own reflection comes
/// from, which lifts a gloss black four times over and leaves every off-axis reflection a flat wash
/// with nothing in it to be a reflection *of*.
///
/// `spread` widens the ceiling's edge by the reach of the lobe reading it, so a matte sheet sees the
/// room averaged where a gloss one mirrors the edge itself.
public float room_profile(float up, float spread)
{
    return lerp(ROOM_LOW, 1.0, smoothstep(ROOM_HORIZON - spread, ROOM_CEILING + spread, up));
}

static const float READER_LOW = 0.03;
static const float READER_INNER = 0.95;
static const float READER_OUTER = 0.82;
static const float READER_SOLID = 0.25;

/// What the reader's own body leaves of the room along a direction, against the cosine to them.
///
/// **A print faced square on mirrors the reader, and the reader is not a lamp.** A body at arm's
/// length covers a quarter of a steradian around the one direction a face-on sheet reflects into
/// the eye, and it is darker than the wall it stands against - which is why a gloss print looks its
/// blackest held straight rather than turned. Nothing here shadows the *diffuse* side: the same
/// cone is a twelfth of the hemisphere and sits in the dim band, worth well under a percent of the
/// illuminance, where a mirror reads this one direction and little else.
///
/// The silhouette washes out as the lobe reading it opens up, in the ratio the two solid angles
/// stand in, so it is a gloss sheet's reflection and barely a matte one's.
public float reader_share(float cosine, float spread)
{
    let lobe = READER_SOLID / (READER_SOLID + 3.141592653589793 * spread * spread);
    return lerp(1.0, READER_LOW, lobe * smoothstep(READER_OUTER, READER_INNER, cosine));
}
