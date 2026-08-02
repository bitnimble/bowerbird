/* The client build binds LibRaw and libavif. lensfun stays out: it is a geometry
   database on disk, and the editor's geometry comes from the RAW's own metadata.
   libavif is here because Firefox composites HDR through video alone, so the editor has
   to hand it a real AV1 frame - the same encoder the renditions use (DESIGN 21.3). */
#include <libraw/libraw.h>
#include <avif/avif.h>
