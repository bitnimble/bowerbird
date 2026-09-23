module print_environment;

static const float ROOM_PI = 3.141592653589793;

static const float ROOM_LOW = 0.2;
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

static const float BOUNCE_HIGH = 0.14;
static const float BOUNCE_FLOOR = -0.45;
static const float BOUNCE_HORIZON = 0.2;

/// The room lit by the lamp rather than by the ambient, on the same terms.
///
/// **A lamp in a room is a second, dimmer room.** What it throws past the print lands on the floor
/// and the lower walls and comes back up, so a sheet turned away from a lamp in a dark room is not
/// black - it is lit by the floor. Modelled apart from the ambient rather than folded into it
/// because the two arrive from opposite halves of the sphere: the ceiling carries one and the floor
/// carries the other, and a sheet tilted down reads them in the opposite order.
public float bounce_profile(float up, float spread)
{
    return lerp(1.0, BOUNCE_HIGH, smoothstep(BOUNCE_FLOOR - spread, BOUNCE_HORIZON + spread, up));
}

/// What a lamp returns as room light, against what it puts on a print facing it.
///
/// A luminaire aimed at a picture puts its beam on the picture and its spill on the room, and the
/// room hands back what it catches in the ratio its own albedo sets - an order of magnitude under
/// the accent level either way. Under an ambient of zero this is the whole of the light reaching a
/// sheet turned away from the lamp, and it has to stay well beneath the lamp's own face: a print
/// turned to the floor is lit by the floor, not better lit than one turned to the lamp.
public static const float ROOM_BOUNCE = 0.1;

static const float READER_LOW = 0.45;
static const float READER_HALF_WIDTH = 0.17;
static const float READER_RISE = 0.11;
static const float READER_DROP = 0.55;
static const float READER_EDGE = 0.05;

/// What the reader's own body leaves of the room along a direction.
///
/// **A print faced square on mirrors the reader, and the reader is not a lamp.** A body is darker
/// than the wall it stands against, which is why a gloss print looks its blackest held straight
/// rather than turned, and a band much wider than the body leaves a sheet under glass with no room
/// in it to reflect at all. Nothing here shadows the *diffuse* side: the same solid angle is worth
/// well under a percent of the illuminance, where a mirror reads one direction and little else.
///
/// **A head is not a silhouette.** Someone in front of a picture is a third of a radian across and
/// most of a radian tall, standing on the floor rather than floating at eye level, so what a pane
/// mirrors is a tall shape hanging below the direction the eye is on - which is why a framed print
/// tilted down its own height still has the reader in it, and one tilted up does not.
///
/// The silhouette washes out as the lobe reading it opens up, in the ratio the two solid angles
/// stand in, so it is a gloss sheet's reflection and barely a matte one's.
public float reader_share(float3 direction, float3 world_view, float spread)
{
    let towards = dot(direction, world_view);
    // The reader stands along the view and nowhere else: an offset across the view runs to zero
    // again for a direction pointing back past them, which would put the body in a sheet's most
    // grazing reflection - the one direction that certainly misses it.
    if (towards <= 0.0) { return 1.0; }
    let side = cross(world_view, float3(0.0, 1.0, 0.0));
    let width = length(side);
    // Looking along the room's own up, where the body has no side to stand to.
    if (width < 1e-4) { return 1.0; }
    let across = side / width;
    let raise = cross(across, world_view);
    let offset = direction / towards - world_view;
    let sideways = max(abs(dot(offset, across)) - READER_HALF_WIDTH, 0.0);
    let along = dot(offset, raise);
    let past = max(max(-along - READER_DROP, along - READER_RISE), 0.0);
    let outside = length(float2(sideways, past));
    let solid = 4.0 * READER_HALF_WIDTH * (READER_RISE + READER_DROP);
    let lobe = solid / (solid + ROOM_PI * spread * spread);
    return lerp(1.0, READER_LOW, lobe * (1.0 - smoothstep(0.0, READER_EDGE + spread, outside)));
}
