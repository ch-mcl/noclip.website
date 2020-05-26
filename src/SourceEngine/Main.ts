
import { SceneContext } from "../SceneBase";
import { GfxDevice, GfxRenderPass, GfxCullMode, GfxHostAccessPass, GfxFormat, GfxInputLayoutBufferDescriptor, GfxVertexAttributeDescriptor, GfxBindingLayoutDescriptor, GfxProgram, GfxVertexBufferFrequency, GfxInputLayout, GfxBuffer, GfxBufferUsage, GfxInputState, GfxTexture } from "../gfx/platform/GfxPlatform";
import { ViewerRenderInput, SceneGfx } from "../viewer";
import { standardFullClearRenderPassDescriptor, BasicRenderTarget, depthClearRenderPassDescriptor } from "../gfx/helpers/RenderTargetHelpers";
import { fillMatrix4x4, fillVec3v } from "../gfx/helpers/UniformBufferHelpers";
import { GfxRenderHelper } from "../gfx/render/GfxRenderGraph";
import { BSPFile, Surface, Model } from "./BSPFile";
import { makeStaticDataBuffer } from "../gfx/helpers/BufferHelpers";
import { GfxRenderInstManager, makeSortKey, GfxRendererLayer, setSortKeyDepth, executeOnPass } from "../gfx/render/GfxRenderer";
import { GfxRenderCache } from "../gfx/render/GfxRenderCache";
import { mat4, vec3 } from "gl-matrix";
import { VPKMount } from "./VPK";
import { ZipFile } from "../ZipFile";
import ArrayBufferSlice from "../ArrayBufferSlice";
import { BaseMaterial, MaterialCache, LightmapManager, SurfaceLightmap, WorldLightingState, MaterialProxySystem, EntityMaterialParameters, MaterialProgramBase } from "./Materials";
import { clamp, computeModelMatrixSRT, MathConstants, getMatrixTranslation } from "../MathHelpers";
import { assertExists } from "../util";
import { BSPEntity, vmtParseNumbers } from "./VMT";
import { computeViewSpaceDepthFromWorldSpacePointAndViewMatrix, Camera } from "../Camera";
import { AABB, Frustum } from "../Geometry";
import { DetailPropLeafRenderer, StaticPropRenderer } from "./StaticDetailObject";
import { StudioModelCache } from "./Studio";
import BitMap from "../BitMap";

export class SourceFileSystem {
    public pakfiles: ZipFile[] = [];
    public mounts: VPKMount[] = [];

    public resolvePath(path: string, ext: string): string {
        path = path.toLowerCase().replace(/\\/g, '/');
        if (!path.endsWith(ext))
            path = `${path}${ext}`;
        return path;
    }

    public searchPath(searchDirs: string[], path: string, ext: string): string | null {
        for (let i = 0; i < searchDirs.length; i++) {
            let searchDir = searchDirs[i];

            // Normalize path separators.
            searchDir = searchDir.replace(/\\/g, '/');
            searchDir = searchDir.replace(/\/\//g, '/');
            if (searchDir.endsWith('/'))
                searchDir = searchDir.slice(0, -1);

            // Attempt searching for a path.
            const finalPath = this.resolvePath(`${searchDir}/${path}`, ext);
            if (this.hasEntry(finalPath))
                return finalPath;
        }

        return null;
    }

    private hasEntry(resolvedPath: string): boolean {
        for (let i = 0; i < this.mounts.length; i++) {
            const entry = this.mounts[i].findEntry(resolvedPath);
            if (entry !== null)
                return true;
        }

        for (let i = 0; i < this.pakfiles.length; i++) {
            const pakfile = this.pakfiles[i];
            const entry = pakfile.find((entry) => entry.filename === resolvedPath);
            if (entry !== undefined)
                return true;
        }

        return false;
    }

    public async fetchFileData(resolvedPath: string): Promise<ArrayBufferSlice | null> {
        for (let i = 0; i < this.mounts.length; i++) {
            const entry = this.mounts[i].findEntry(resolvedPath);
            if (entry !== null)
                return this.mounts[i].fetchFileData(entry);
        }

        for (let i = 0; i < this.pakfiles.length; i++) {
            const pakfile = this.pakfiles[i];
            const entry = pakfile.find((entry) => entry.filename === resolvedPath);
            if (entry !== undefined)
                return entry.data;
        }

        return null;
    }

    public destroy(device: GfxDevice): void {
    }
}

// In Source, the convention is +X for forward and -X for backward, +Y for left and -Y for right, and +Z for up and -Z for down.
// Converts from Source conventions to noclip ones.
export const noclipSpaceFromSourceEngineSpace = mat4.fromValues(
    0,  0, -1, 0,
    -1, 0,  0, 0,
    0,  1,  0, 0,
    0,  0,  0, 1,
);

export class SkyboxRenderer {
    private vertexBuffer: GfxBuffer;
    private indexBuffer: GfxBuffer;
    private inputLayout: GfxInputLayout;
    private inputState: GfxInputState;
    private materialInstances: BaseMaterial[] = [];
    private modelMatrix = mat4.create();

    constructor(renderContext: SourceRenderContext, private skyname: string) {
        const device = renderContext.device, cache = renderContext.cache;

        const vertexData = new Float32Array(6 * 4 * 5);
        const indexData = new Uint16Array(6 * 6);

        let dstVert = 0;
        let dstIdx = 0;

        function buildPlaneVert(pb: number, s: number, t: number): void {
            const side = 5000000;
            const g = [-s*side, s*side, -t*side, t*side, -side, side];
            vertexData[dstVert++] = g[(pb >>> 8) & 0x0F];
            vertexData[dstVert++] = g[(pb >>> 4) & 0x0F];
            vertexData[dstVert++] = g[(pb >>> 0) & 0x0F];

            function seamClamp(v: number): number {
                return clamp(v, 1.0/512.0, 511.0/512.0);
            }

            vertexData[dstVert++] = seamClamp(s * 0.5 + 0.5);
            vertexData[dstVert++] = seamClamp(1.0 - (t * 0.5 + 0.5));
        }

        function buildPlaneData(pb: number): void {
            const base = dstVert/5;
            buildPlaneVert(pb, -1, -1);
            buildPlaneVert(pb, -1, 1);
            buildPlaneVert(pb, 1, 1);
            buildPlaneVert(pb, 1, -1);
            indexData[dstIdx++] = base+0;
            indexData[dstIdx++] = base+1;
            indexData[dstIdx++] = base+2;
            indexData[dstIdx++] = base+0;
            indexData[dstIdx++] = base+2;
            indexData[dstIdx++] = base+3;
        }

        // right, left, back, front, top, bottom
        buildPlaneData(0x503);
        buildPlaneData(0x413);
        buildPlaneData(0x153);
        buildPlaneData(0x043);
        buildPlaneData(0x205);
        buildPlaneData(0x304);

        this.vertexBuffer = makeStaticDataBuffer(device, GfxBufferUsage.VERTEX, vertexData.buffer);
        this.indexBuffer = makeStaticDataBuffer(device, GfxBufferUsage.INDEX, indexData.buffer);

        const vertexAttributeDescriptors: GfxVertexAttributeDescriptor[] = [
            { location: MaterialProgramBase.a_Position, bufferIndex: 0, bufferByteOffset: 0*0x04, format: GfxFormat.F32_RGB, },
            { location: MaterialProgramBase.a_TexCoord, bufferIndex: 0, bufferByteOffset: 3*0x04, format: GfxFormat.F32_RG, },
        ];
        const vertexBufferDescriptors: GfxInputLayoutBufferDescriptor[] = [
            { byteStride: (3+2)*0x04, frequency: GfxVertexBufferFrequency.PER_VERTEX, },
        ];
        const indexBufferFormat = GfxFormat.U16_R;
        this.inputLayout = cache.createInputLayout(device, { vertexAttributeDescriptors, vertexBufferDescriptors, indexBufferFormat });

        this.inputState = device.createInputState(this.inputLayout, [
            { buffer: this.vertexBuffer, byteOffset: 0, },
        ], { buffer: this.indexBuffer, byteOffset: 0, });

        this.bindMaterial(renderContext);
    }

    private async bindMaterial(renderContext: SourceRenderContext) {
        const materialCache = renderContext.materialCache;
        this.materialInstances = await Promise.all([
            materialCache.createMaterialInstance(renderContext, `skybox/${this.skyname}rt`),
            materialCache.createMaterialInstance(renderContext, `skybox/${this.skyname}lf`),
            materialCache.createMaterialInstance(renderContext, `skybox/${this.skyname}bk`),
            materialCache.createMaterialInstance(renderContext, `skybox/${this.skyname}ft`),
            materialCache.createMaterialInstance(renderContext, `skybox/${this.skyname}up`),
            materialCache.createMaterialInstance(renderContext, `skybox/${this.skyname}dn`),
        ]);
    }

    public prepareToRender(renderContext: SourceRenderContext, renderInstManager: GfxRenderInstManager, view: SourceEngineView): void {
        // Wait until we're ready.
        if (this.materialInstances.length === 0)
            return;

        for (let i = 0; i < this.materialInstances.length; i++)
            if (!this.materialInstances[i].isMaterialLoaded())
                return;

        const template = renderInstManager.pushTemplateRenderInst();
        template.setInputLayoutAndState(this.inputLayout, this.inputState);

        let offs = template.allocateUniformBuffer(MaterialProgramBase.ub_SceneParams, 32);
        const d = template.mapUniformBufferF32(MaterialProgramBase.ub_SceneParams);
        offs += fillMatrix4x4(d, offs, view.clipFromWorldMatrix);
        offs += fillVec3v(d, offs, view.cameraPos);

        for (let i = 0; i < 6; i++) {
            if (!this.materialInstances[i].visible)
                continue;
            const renderInst = renderInstManager.newRenderInst();
            this.materialInstances[i].setOnRenderInst(renderContext, renderInst, this.modelMatrix);
            renderInst.sortKey = makeSortKey(GfxRendererLayer.BACKGROUND);
            renderInst.drawIndexes(6, i*6);
            renderInstManager.submitRenderInst(renderInst);
        }

        renderInstManager.popTemplateRenderInst();
    }

    public destroy(device: GfxDevice): void {
        device.destroyBuffer(this.vertexBuffer);
        device.destroyBuffer(this.indexBuffer);
        device.destroyInputState(this.inputState);
    }
}

class BSPSurfaceRenderer {
    public visible = true;
    public materialInstance: BaseMaterial | null = null;
    public lightmaps: SurfaceLightmap[] = [];
    // displacement
    public clusterset: number[] | null = null;

    constructor(public surface: Surface) {
    }

    public bindMaterial(materialInstance: BaseMaterial, lightmapManager: LightmapManager): void {
        this.materialInstance = materialInstance;

        for (let i = 0; i < this.surface.lightmapData.length; i++) {
            const lightmapData = this.surface.lightmapData[i];
            this.lightmaps.push(new SurfaceLightmap(lightmapManager, lightmapData, this.materialInstance.wantsLightmap, this.materialInstance.wantsBumpmappedLightmap));
        }

        this.materialInstance.setLightmapAllocation(lightmapManager.getPageTexture(this.surface.lightmapPageIndex), lightmapManager.gfxSampler);
    }

    public movement(renderContext: SourceRenderContext): void {
        if (!this.visible || this.materialInstance === null)
            return;

        this.materialInstance.movement(renderContext);
    }

    public prepareToRender(renderContext: SourceRenderContext, renderInstManager: GfxRenderInstManager, view: SourceEngineView, modelMatrix: mat4, pvs: BitMap | null = null) {
        if (!this.visible || this.materialInstance === null || !this.materialInstance.visible || !this.materialInstance.isMaterialLoaded())
            return;

        if (pvs !== null) {
            // displacement check
            const clusterset = assertExists(this.clusterset);
            let visible = false;
            for (let i = 0; i < clusterset.length; i++) {
                if (pvs.getBit(clusterset[i])) {
                    visible = true;
                    break;
                }
            }

            if (!visible)
                return;
        }

        if (this.surface.bbox !== null) {
            scratchAABB.transform(this.surface.bbox, modelMatrix);
            if (!view.frustum.contains(scratchAABB))
                return;
        }

        for (let i = 0; i < this.lightmaps.length; i++)
            this.lightmaps[i].buildLightmap(renderContext.worldLightingState);

        const renderInst = renderInstManager.newRenderInst();
        this.materialInstance.setOnRenderInst(renderContext, renderInst, modelMatrix);
        renderInst.drawIndexes(this.surface.indexCount, this.surface.startIndex);

        if (this.surface.center !== null) {
            const depth = computeViewSpaceDepthFromWorldSpacePointAndViewMatrix(view.viewFromWorldMatrix, this.surface.center);
            renderInst.sortKey = setSortKeyDepth(renderInst.sortKey, depth);
        }

        renderInstManager.submitRenderInst(renderInst);
    }
}

const scratchAABB = new AABB();
class BSPModelRenderer {
    public visible: boolean = true;
    public modelMatrix = mat4.create();
    public entity: BaseEntity | null = null;
    public surfaces: BSPSurfaceRenderer[] = [];
    public surfacesByIdx: BSPSurfaceRenderer[] = [];
    public displacementSurfaces: BSPSurfaceRenderer[] = [];
    public materialInstances: BaseMaterial[] = [];
    public liveSurfaceSet = new Set<number>();

    constructor(renderContext: SourceRenderContext, public model: Model, public bsp: BSPFile) {
        for (let i = 0; i < model.surfaces.length; i++) {
            const surfaceIdx = model.surfaces[i];
            const surface = new BSPSurfaceRenderer(this.bsp.surfaces[surfaceIdx]);
            this.bindMaterial(renderContext, surface);
            // TODO(jstpierre): This is ugly
            this.surfaces.push(surface);
            this.surfacesByIdx[surfaceIdx] = surface;

            if (surface.surface.isDisplacement) {
                const aabb = surface.surface.bbox!;
                this.displacementSurfaces.push(surface);
                surface.clusterset = [];
                this.bsp.markClusterSet(surface.clusterset, aabb);
            }
        }
    }

    public setEntity(entity: BaseEntity): void {
        this.entity = entity;
        for (let i = 0; i < this.surfaces.length; i++)
            if (this.surfaces[i] !== undefined && this.surfaces[i].materialInstance !== null)
                this.surfaces[i].materialInstance!.entityParams = entity.materialParams;
    }

    private async bindMaterial(renderContext: SourceRenderContext, surface: BSPSurfaceRenderer) {
        const materialCache = renderContext.materialCache;

        if (this.materialInstances[surface.surface.texinfo] === undefined) {
            const texinfo = this.bsp.texinfo[surface.surface.texinfo];
            const materialInstance = await materialCache.createMaterialInstance(renderContext, texinfo.texName);
            this.materialInstances[surface.surface.texinfo] = materialInstance;
        }

        const materialInstance = this.materialInstances[surface.surface.texinfo];
        if (this.entity !== null)
            materialInstance.entityParams = this.entity.materialParams;

        surface.bindMaterial(materialInstance, renderContext.lightmapManager);
    }

    public movement(renderContext: SourceRenderContext): void {
        if (!this.visible)
            return;

        for (let i = 0; i < this.surfaces.length; i++)
            this.surfaces[i].movement(renderContext);
    }

    public gatherSurfaces(liveSurfaceSet: Set<number> | null, liveLeafSet: Set<number> | null, pvs: BitMap, view: SourceEngineView, nodeid: number = this.model.headnode): void {
        if (nodeid >= 0) {
            // node
            const node = this.bsp.nodelist[nodeid];

            scratchAABB.transform(node.bbox, this.modelMatrix);
            if (!view.frustum.contains(scratchAABB))
                return;

            this.gatherSurfaces(liveSurfaceSet, liveLeafSet, pvs, view, node.child0);
            this.gatherSurfaces(liveSurfaceSet, liveLeafSet, pvs, view, node.child1);

            // Node surfaces are func_detail meshes, but they appear to also be in leaves... don't know if we need them.
            /*
            if (liveSurfaceSet !== null)
                for (let i = 0; i < node.surfaces.length; i++)
                    liveSurfaceSet.add(node.surfaces[i]);
            */
        } else {
            // leaf
            const leafnum = -nodeid - 1;
            const leaf = this.bsp.leaflist[leafnum];

            if (!pvs.getBit(leaf.cluster))
                return;

            scratchAABB.transform(leaf.bbox, this.modelMatrix);
            if (!view.frustum.contains(scratchAABB))
                return;

            if (liveLeafSet !== null)
                liveLeafSet.add(leafnum);

            if (liveSurfaceSet !== null)
                for (let i = 0; i < leaf.surfaces.length; i++)
                    liveSurfaceSet.add(leaf.surfaces[i]);
        }
    }

    public prepareToRender(renderContext: SourceRenderContext, renderInstManager: GfxRenderInstManager, view: SourceEngineView, pvs: BitMap, traverseBrush: boolean): void {
        if (!this.visible)
            return;

        scratchAABB.transform(this.model.bbox, this.modelMatrix);
        if (!view.frustum.contains(scratchAABB))
            return;

        // Render all displacement surfaces.
        // TODO(jstpierre): Move this to the BSP leaves
        for (let i = 0; i < this.displacementSurfaces.length; i++)
            this.displacementSurfaces[i].prepareToRender(renderContext, renderInstManager, view, this.modelMatrix, pvs);

        if (traverseBrush) {
            // Gather all BSP surfaces, and cull based on that.
            this.liveSurfaceSet.clear();
            this.gatherSurfaces(this.liveSurfaceSet, null, pvs, view);

            for (const surfaceIdx of this.liveSurfaceSet.values())
                this.surfacesByIdx[surfaceIdx].prepareToRender(renderContext, renderInstManager, view, this.modelMatrix);
        } else {
            // Entities don't use the BSP tree, they simply render all surfaces back to back in a batch.
            for (let i = 0; i < this.model.surfaces.length; i++)
                this.surfacesByIdx[this.model.surfaces[i]].prepareToRender(renderContext, renderInstManager, view, this.modelMatrix);
        }
    }
}

export function computeModelMatrixPosRot(dst: mat4, pos: vec3, rot: vec3): void {
    const rotX = MathConstants.DEG_TO_RAD * rot[0];
    const rotY = MathConstants.DEG_TO_RAD * rot[1];
    const rotZ = MathConstants.DEG_TO_RAD * rot[2];
    const transX = pos[0];
    const transY = pos[1];
    const transZ = pos[2];
    computeModelMatrixSRT(dst, 1, 1, 1, rotX, rotY, rotZ, transX, transY, transZ);
}

class BaseEntity {
    public model: BSPModelRenderer | null = null;
    public origin = vec3.create();
    public angles = vec3.create();
    public visible = true;
    public materialParams = new EntityMaterialParameters();

    constructor(renderContext: SourceRenderContext, bspRenderer: BSPRenderer, private entity: BSPEntity) {
        if (entity.model) {
            if (entity.model.startsWith('*')) {
                const index = parseInt(entity.model.slice(1), 10);
                this.model = bspRenderer.models[index];
                this.model.setEntity(this);
            } else {
                // External model reference.
            }
        }

        if (entity.origin) {
            const origin = vmtParseNumbers(entity.origin);
            vec3.set(this.origin, origin[0], origin[1], origin[2]);
        }

        if (entity.angles) {
            const angles = vmtParseNumbers(entity.angles);
            vec3.set(this.angles, angles[0], angles[1], angles[2]);
        }
    }

    public movement(): void {
        if (this.model !== null) {
            computeModelMatrixPosRot(this.model.modelMatrix, this.origin, this.angles);
            this.model.visible = this.visible;

            vec3.copy(this.materialParams.position, this.origin);
        }
    }
}

class sky_camera extends BaseEntity {
    public static classname = 'sky_camera';
    public area: number = -1;
    public scale: number = 1;
    public modelMatrix = mat4.create();

    constructor(renderContext: SourceRenderContext, bspRenderer: BSPRenderer, entity: BSPEntity) {
        super(renderContext, bspRenderer, entity);
        const leafnum = bspRenderer.bsp.findLeafForPoint(this.origin);
        this.area = bspRenderer.bsp.leaflist[leafnum].area;
        this.scale = Number(entity.scale);
        computeModelMatrixSRT(this.modelMatrix, this.scale, this.scale, this.scale, 0, 0, 0,
            this.scale * -this.origin[0],
            this.scale * -this.origin[1],
            this.scale * -this.origin[2]);
    }
}

class water_lod_control extends BaseEntity {
    public static classname = 'water_lod_control';

    constructor(renderContext: SourceRenderContext, bspRenderer: BSPRenderer, entity: BSPEntity) {
        super(renderContext, bspRenderer, entity);
        if (entity.cheapwaterstartdistance !== undefined)
            renderContext.cheapWaterStartDistance = Number(entity.cheapwaterstartdistance);
        if (entity.cheapwaterenddistance !== undefined)
            renderContext.cheapWaterEndDistance = Number(entity.cheapwaterenddistance);
    }
}

interface EntityFactory {
    new(renderContext: SourceRenderContext, bspRenderer: BSPRenderer, entity: BSPEntity): BaseEntity;
    classname: string;
}

class EntitySystem {
    public classname = new Map<string, EntityFactory>();

    constructor() {
        this.registerDefaultFactories();
    }

    private registerDefaultFactories(): void {
        this.registerFactory(sky_camera);
        this.registerFactory(water_lod_control);
    }

    public registerFactory(factory: EntityFactory): void {
        this.classname.set(factory.classname, factory);
    }

    public createEntity(renderContext: SourceRenderContext, renderer: BSPRenderer, entity: BSPEntity): BaseEntity {
        const factory = this.classname.has(entity.classname) ? this.classname.get(entity.classname)! : BaseEntity;
        return new factory(renderContext, renderer, entity);
    }
}

const enum FilterKey { Skybox, Main }

// A "View" is effectively a camera, but in Source engine space.
export class SourceEngineView {
    // aka viewMatrix
    public viewFromWorldMatrix = mat4.create();
    // aka worldMatrix
    public worldFromViewMatrix = mat4.create();
    public clipFromWorldMatrix = mat4.create();

    // The current camera position, in Source engine world space.
    public cameraPos = vec3.create();

    // Frustum is stored in Source engine world space.
    public frustum = new Frustum();

    public setupFromCamera(camera: Camera, extraTransformInSourceEngineSpace: mat4 | null = null): void {
        mat4.mul(this.viewFromWorldMatrix, camera.viewMatrix, noclipSpaceFromSourceEngineSpace);
        if (extraTransformInSourceEngineSpace !== null)
            mat4.mul(this.viewFromWorldMatrix, this.viewFromWorldMatrix, extraTransformInSourceEngineSpace);
        mat4.invert(this.worldFromViewMatrix, this.viewFromWorldMatrix);
        mat4.mul(this.clipFromWorldMatrix, camera.projectionMatrix, this.viewFromWorldMatrix);
        getMatrixTranslation(this.cameraPos, this.worldFromViewMatrix);

        this.frustum.copyViewFrustum(camera.frustum);
        this.frustum.updateWorldFrustum(this.worldFromViewMatrix);

        // Compute camera position.

        this.frustum.newFrame();
    }
}

const enum RenderObjectKind {
    WorldSpawn  = 1 << 0,
    Entities    = 1 << 1,
    StaticProps = 1 << 2,
    DetailProps = 1 << 3,
}

export class BSPRenderer {
    private vertexBuffer: GfxBuffer;
    private indexBuffer: GfxBuffer;
    private inputLayout: GfxInputLayout;
    private inputState: GfxInputState;
    private entities: BaseEntity[] = [];
    public models: BSPModelRenderer[] = [];
    public detailPropLeafRenderers: DetailPropLeafRenderer[] = [];
    public staticPropRenderers: StaticPropRenderer[] = [];
    public liveLeafSet = new Set<number>();

    constructor(renderContext: SourceRenderContext, public bsp: BSPFile) {
        renderContext.lightmapManager.appendPackerManager(this.bsp.lightmapPackerManager);

        const device = renderContext.device, cache = renderContext.cache;
        this.vertexBuffer = makeStaticDataBuffer(device, GfxBufferUsage.VERTEX, this.bsp.vertexData.buffer);
        this.indexBuffer = makeStaticDataBuffer(device, GfxBufferUsage.INDEX, this.bsp.indexData.buffer);

        const vertexAttributeDescriptors: GfxVertexAttributeDescriptor[] = [
            { location: MaterialProgramBase.a_Position, bufferIndex: 0, bufferByteOffset: 0*0x04, format: GfxFormat.F32_RGB, },
            { location: MaterialProgramBase.a_Normal,   bufferIndex: 0, bufferByteOffset: 3*0x04, format: GfxFormat.F32_RGBA, },
            { location: MaterialProgramBase.a_TangentS, bufferIndex: 0, bufferByteOffset: 7*0x04, format: GfxFormat.F32_RGBA, },
            { location: MaterialProgramBase.a_TexCoord, bufferIndex: 0, bufferByteOffset: 11*0x04, format: GfxFormat.F32_RGBA, },
        ];
        const vertexBufferDescriptors: GfxInputLayoutBufferDescriptor[] = [
            { byteStride: (3+4+4+4)*0x04, frequency: GfxVertexBufferFrequency.PER_VERTEX, },
        ];
        const indexBufferFormat = GfxFormat.U32_R;
        this.inputLayout = cache.createInputLayout(device, { vertexAttributeDescriptors, vertexBufferDescriptors, indexBufferFormat });

        this.inputState = device.createInputState(this.inputLayout, [
            { buffer: this.vertexBuffer, byteOffset: 0, },
        ], { buffer: this.indexBuffer, byteOffset: 0, });

        for (let i = 0; i < this.bsp.models.length; i++) {
            const model = this.bsp.models[i];
            const modelRenderer = new BSPModelRenderer(renderContext, model, bsp);
            // Non-world-spawn models are invisible by default (they're lifted into the world by entities).
            modelRenderer.visible = (i === 0);
            this.models.push(modelRenderer);
        }

        // Spawn entities.
        for (let i = 0; i < this.bsp.entities.length; i++)
            this.entities.push(renderContext.entitySystem.createEntity(renderContext, this, this.bsp.entities[i]));

        // Spawn static objects.
        if (this.bsp.staticObjects !== null)
            for (const staticProp of this.bsp.staticObjects.staticProps)
                this.staticPropRenderers.push(new StaticPropRenderer(renderContext, staticProp));

        // Spawn detail objects.
        if (this.bsp.detailObjects !== null)
            for (const leaf of this.bsp.detailObjects.leafDetailModels.keys())
                this.detailPropLeafRenderers.push(new DetailPropLeafRenderer(renderContext, this.bsp.detailObjects, leaf));
    }

    public getSkyCameraModelMatrix(): mat4 | null {
        const skyCameraEntity = this.entities.find((entity) => entity instanceof sky_camera) as sky_camera;
        return skyCameraEntity !== undefined ? skyCameraEntity.modelMatrix : null;
    }

    public movement(renderContext: SourceRenderContext): void {
        for (let i = 0; i < this.entities.length; i++)
            this.entities[i].movement();
        for (let i = 0; i < this.models.length; i++)
            this.models[i].movement(renderContext);
        for (let i = 0; i < this.staticPropRenderers.length; i++)
            this.staticPropRenderers[i].movement(renderContext);
    }

    public prepareToRenderView(renderContext: SourceRenderContext, renderInstManager: GfxRenderInstManager, view: SourceEngineView, pvs: BitMap, kinds: RenderObjectKind): void {
        const template = renderInstManager.pushTemplateRenderInst();

        let offs = template.allocateUniformBuffer(MaterialProgramBase.ub_SceneParams, 32);
        const d = template.mapUniformBufferF32(MaterialProgramBase.ub_SceneParams);
        offs += fillMatrix4x4(d, offs, view.clipFromWorldMatrix);
        offs += fillVec3v(d, offs, view.cameraPos);

        template.setInputLayoutAndState(this.inputLayout, this.inputState);

        // Render the world-spawn model.
        if (!!(kinds & RenderObjectKind.WorldSpawn))
            this.models[0].prepareToRender(renderContext, renderInstManager, view, pvs, true);

        if (!!(kinds & RenderObjectKind.Entities)) {
            for (let i = 1; i < this.models.length; i++)
                this.models[i].prepareToRender(renderContext, renderInstManager, view, pvs, false);
        }

        // Static props.
        if (!!(kinds & RenderObjectKind.StaticProps)) {
            for (let i = 0; i < this.staticPropRenderers.length; i++)
                this.staticPropRenderers[i].prepareToRender(renderContext, renderInstManager, this.bsp, pvs);
        }

        // Detail props.
        if (!!(kinds & RenderObjectKind.DetailProps)) {
            this.liveLeafSet.clear();
            this.models[0].gatherSurfaces(null, this.liveLeafSet, pvs, view);

            for (let i = 0; i < this.detailPropLeafRenderers.length; i++) {
                const detailPropLeafRenderer = this.detailPropLeafRenderers[i];
                if (!this.liveLeafSet.has(detailPropLeafRenderer.leaf))
                    continue;
                detailPropLeafRenderer.prepareToRender(renderContext, renderInstManager, view);
            }
        }

        renderInstManager.popTemplateRenderInst();
    }

    public destroy(device: GfxDevice): void {
        device.destroyBuffer(this.vertexBuffer);
        device.destroyBuffer(this.indexBuffer);
        device.destroyInputState(this.inputState);

        for (let i = 0; i < this.detailPropLeafRenderers.length; i++)
            this.detailPropLeafRenderers[i].destroy(device);
    }
}

export class SourceRenderContext {
    public lightmapManager: LightmapManager;
    public studioModelCache: StudioModelCache;
    public materialCache: MaterialCache;
    public worldLightingState = new WorldLightingState();
    public globalTime: number = 0;
    public materialProxySystem = new MaterialProxySystem();
    public entitySystem = new EntitySystem();
    public cheapWaterStartDistance = 0.0;
    public cheapWaterEndDistance = 0.1;
    public currentView: SourceEngineView;

    constructor(public device: GfxDevice, public cache: GfxRenderCache, public filesystem: SourceFileSystem) {
        this.lightmapManager = new LightmapManager(device, cache);
        this.materialCache = new MaterialCache(device, cache, this.filesystem);
        this.studioModelCache = new StudioModelCache(this, this.filesystem);
    }

    public destroy(device: GfxDevice): void {
        this.lightmapManager.destroy(device);
        this.materialCache.destroy(device);
    }
}

const bindingLayouts: GfxBindingLayoutDescriptor[] = [
    { numUniformBuffers: 2, numSamplers: 7 },
];

const scratchVec3 = vec3.create();
const scratchMatrix = mat4.create();
export class SourceRenderer implements SceneGfx {
    private renderTarget = new BasicRenderTarget();
    public renderHelper: GfxRenderHelper;
    public skyboxRenderer: SkyboxRenderer | null = null;
    public bspRenderers: BSPRenderer[] = [];
    public renderContext: SourceRenderContext;

    // Scratch
    public mainView = new SourceEngineView();
    public skyboxView = new SourceEngineView();
    public pvsScratch = new BitMap(65536);

    constructor(context: SceneContext, filesystem: SourceFileSystem) {
        const device = context.device;
        this.renderHelper = new GfxRenderHelper(device);
        this.renderContext = new SourceRenderContext(device, this.renderHelper.getCache(), filesystem);
    }

    private movement(): void {
        for (let i = 0; i < this.bspRenderers.length; i++)
            this.bspRenderers[i].movement(this.renderContext);
    }

    public calcPVS(bsp: BSPFile, pvs: BitMap, view: SourceEngineView): boolean {
        // Compute PVS from view.
        const leafid = bsp.findLeafForPoint(view.cameraPos);

        if (leafid >= 0) {
            const leaf = bsp.leaflist[leafid];

            if (leaf.cluster !== 0xFFFF) {
                // Has valid visibility.
                pvs.fill(false);
                pvs.or(bsp.visibility.pvs[leaf.cluster]);
                return true;
            }
        }

        return false;
    }

    private prepareToRender(device: GfxDevice, hostAccessPass: GfxHostAccessPass, viewerInput: ViewerRenderInput): void {
        // globalTime is in seconds.
        this.renderContext.globalTime = viewerInput.time / 1000.0;

        // Set up our views.
        this.mainView.setupFromCamera(viewerInput.camera);

        // Position the 2D skybox around the main view.
        vec3.negate(scratchVec3, this.mainView.cameraPos);
        mat4.fromTranslation(scratchMatrix, this.mainView.cameraPos);
        this.skyboxView.setupFromCamera(viewerInput.camera, scratchMatrix);

        // Fill in the current view with the main view. This is what's used for material proxies.
        this.renderContext.currentView = this.mainView;

        this.movement();

        const renderInstManager = this.renderHelper.renderInstManager;

        const template = this.renderHelper.pushTemplateRenderInst();
        template.setMegaStateFlags({ cullMode: GfxCullMode.BACK });
        template.setBindingLayouts(bindingLayouts);

        template.filterKey = FilterKey.Skybox;
        if (this.skyboxRenderer !== null)
            this.skyboxRenderer.prepareToRender(this.renderContext, renderInstManager, this.skyboxView);

        for (let i = 0; i < this.bspRenderers.length; i++) {
            const bspRenderer = this.bspRenderers[i];

            // Draw the skybox by positioning us inside the skybox area.
            const skyCameraModelMatrix = bspRenderer.getSkyCameraModelMatrix();
            if (skyCameraModelMatrix === null)
                continue;
            this.skyboxView.setupFromCamera(viewerInput.camera, skyCameraModelMatrix);

            // If our skybox is not in a useful spot, then don't render it.
            if (!this.calcPVS(bspRenderer.bsp, this.pvsScratch, this.skyboxView))
                continue;

            bspRenderer.prepareToRenderView(this.renderContext, renderInstManager, this.skyboxView, this.pvsScratch, RenderObjectKind.WorldSpawn | RenderObjectKind.StaticProps);
        }

        template.filterKey = FilterKey.Main;
        for (let i = 0; i < this.bspRenderers.length; i++) {
            const bspRenderer = this.bspRenderers[i];

            if (!this.calcPVS(bspRenderer.bsp, this.pvsScratch, this.mainView)) {
                // No valid PVS, mark everything visible.
                this.pvsScratch.fill(true);
            }

            bspRenderer.prepareToRenderView(this.renderContext, renderInstManager, this.mainView, this.pvsScratch, RenderObjectKind.WorldSpawn | RenderObjectKind.Entities | RenderObjectKind.StaticProps | RenderObjectKind.DetailProps);
        }

        renderInstManager.popTemplateRenderInst();

        // Update our lightmaps right before rendering.
        this.renderContext.lightmapManager.prepareToRender(device);

        this.renderHelper.prepareToRender(device, hostAccessPass);
    }

    public render(device: GfxDevice, viewerInput: ViewerRenderInput): GfxRenderPass {
        const hostAccessPass = device.createHostAccessPass();
        this.prepareToRender(device, hostAccessPass, viewerInput);
        device.submitPass(hostAccessPass);

        this.renderTarget.setParameters(device, viewerInput.backbufferWidth, viewerInput.backbufferHeight);

        let passRenderer: GfxRenderPass;
        passRenderer = this.renderTarget.createRenderPass(device, viewerInput.viewport, standardFullClearRenderPassDescriptor);
        executeOnPass(this.renderHelper.renderInstManager, device, passRenderer, FilterKey.Skybox);
        device.submitPass(passRenderer);

        passRenderer = this.renderTarget.createRenderPass(device, viewerInput.viewport, depthClearRenderPassDescriptor);
        executeOnPass(this.renderHelper.renderInstManager, device, passRenderer, FilterKey.Main);
        device.submitPass(passRenderer);

        this.renderHelper.renderInstManager.resetRenderInsts();
        return passRenderer;
    }

    public destroy(device: GfxDevice): void {
        this.renderTarget.destroy(device);
        this.renderHelper.destroy(device);
        this.renderContext.destroy(device);
        if (this.skyboxRenderer !== null)
            this.skyboxRenderer.destroy(device);
        for (let i = 0; i < this.bspRenderers.length; i++)
            this.bspRenderers[i].destroy(device);
    }
}
