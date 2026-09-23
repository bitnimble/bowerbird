module print_parameters;

public struct PrintParams {
    public float4 rotation;
    public float4 light;
    public float4 material;
    public float4 illumination;
    public float4 surface;
    public float4 framing;
    public float4 view;
};

[vk::binding(0, 1)] public ConstantBuffer<PrintParams> print;
