module print_environment;
import px;

static const float ROOM_PI = 3.141592653589793;

static const float ROOM_LOW = 0.5;
static const float ROOM_HORIZON = 0.1;
static const float ROOM_CEILING = 0.5;

/// The room's walls, floor and ceiling, as radiance against the sine of the elevation looked along,
/// in shares of the ceiling's own.
///
/// `spread` widens the ceiling's edge by the reach of the lobe reading it, so a matte sheet sees the
/// room averaged where a gloss one mirrors the edge itself.
float room_profile(float up, float spread)
{
    return lerp(ROOM_LOW, 1.0, smoothstep(ROOM_HORIZON - spread, ROOM_CEILING + spread, up));
}

static const Extent<Millimetre> SIDE_WALL = { 2500.0 };
static const Extent<Millimetre> REAR_WALL = { 3000.0 };
static const Extent<Millimetre> READER_WALL = { 3500.0 };
static const Extent<Millimetre> CEILING_HEIGHT = { 1200.0 };
static const Extent<Millimetre> FLOOR_DEPTH = { 1500.0 };
static const Extent<Millimetre> WINDOW_SILL = { -600.0 };
static const Extent<Millimetre> WINDOW_HEAD = { 900.0 };
static const Extent<Millimetre> SIDE_WINDOW_FROM = { -1500.0 };
static const Extent<Millimetre> SIDE_WINDOW_TO = { 2500.0 };
static const Extent<Millimetre> REAR_WINDOW_HALF = { 1500.0 };
static const float WINDOW_RADIANCE = 6.0;

/// The room's radiance along a world direction, in shares of the ceiling's own: [`room_profile`],
/// and daylight through windows in both side walls and the wall behind the print.
///
/// **The windows are the room's bright parts, and a sheet mirrors them as bands.** Without them the
/// ceiling carries the whole ambient at several times a white page, and a sheet tipped back mirrors
/// it edge to edge as one flat veil. None in the wall behind the reader: a pane faced square on
/// would carry it.
///
/// Measured from the print's centre, which the sheet is small enough beside the room to stand for.
public float room_shape(Room room, float3 direction, float spread)
{
    return lerp(room_profile(direction.y, spread), WINDOW_RADIANCE, window_share(room, direction, spread));
}

/// The walls and windows as millimetres, taken out of their units once for a caller that reads
/// them in a loop.
public struct Room
{
    float side;
    float rear;
    float reader;
    float ceiling;
    float floor;
    float sill;
    float head;
    float side_from;
    float side_to;
    float rear_half;
}

public void measure_room(out Room room)
{
    room.side = SIDE_WALL.d;
    room.rear = REAR_WALL.d;
    room.reader = READER_WALL.d;
    room.ceiling = CEILING_HEIGHT.d;
    room.floor = FLOOR_DEPTH.d;
    room.sill = WINDOW_SILL.d;
    room.head = WINDOW_HEAD.d;
    room.side_from = SIDE_WINDOW_FROM.d;
    room.side_to = SIDE_WINDOW_TO.d;
    room.rear_half = REAR_WINDOW_HALF.d;
}

float window_share(Room room, float3 direction, float spread)
{
    let away = max(abs(direction), float3(1e-6));
    let reach = float3(room.side, direction.y > 0.0 ? room.ceiling : room.floor,
        direction.z > 0.0 ? room.reader : room.rear) / away;
    let distance = min(reach.x, min(reach.y, reach.z));
    let at = direction * distance;
    // A lobe's spread in radians, times how far away the wall it lands on is; a pane's own is a
    // pixel's worth rather than none, or the window's edge aliases.
    let blur = max(spread, 0.002) * distance;
    let height = rectangle(at.y, room.sill, room.head, blur);
    if (reach.x <= distance) { return height * rectangle(at.z, room.side_from, room.side_to, blur); }
    if (reach.z <= distance && direction.z < 0.0) {
        return height * rectangle(at.x, -room.rear_half, room.rear_half, blur);
    }
    return 0.0;
}

float rectangle(float at, float from, float to, float blur)
{
    return saturate((min(at - from, to - at)) / blur + 0.5);
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
