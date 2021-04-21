﻿import * as GMA from './gma';
import * as GX from "../gx/gx_enum";
import * as GX_Material from '../gx/gx_material';
import { AVTexture, AVTpl } from './AVtpl';

import { LoadedVertexData, LoadedVertexDraw } from '../gx/gx_displaylist';
import { GfxBufferCoalescerCombo } from "../gfx/helpers/BufferHelpers";
import { GfxDevice, GfxMipFilterMode, GfxNormalizedViewportCoords, GfxSampler, GfxTexFilterMode } from "../gfx/platform/GfxPlatform";
import { GfxRenderCache } from "../gfx/render/GfxRenderCache";
import { ColorKind, GXMaterialHelperGfx, GXShapeHelperGfx, GXTextureHolder, loadedDataCoalescerComboGfx, MaterialParams, PacketParams, translateWrapModeGfx } from "../gx/gx_render";
import { mat4 } from 'gl-matrix';
import { Camera, computeViewMatrix, computeViewMatrixSkybox } from '../Camera';
import { Color, colorCopy } from '../Color';
import { nArray } from '../util';
import { AABB, IntersectionState } from '../Geometry';
import { ViewerRenderInput } from '../viewer';
import { TextureMapping } from '../TextureHolder';
import { GXMaterialBuilder } from '../gx/GXMaterialBuilder';
import { GfxRenderInstManager, setSortKeyDepth, setSortKeyBias, GfxRendererLayer, makeSortKey, GfxRenderInst } from '../gfx/render/GfxRenderInstManager';
import { computeNormalMatrix } from '../MathHelpers';


export class GMAData {
    public gma: GMA.GMA;
    public tpl: AVTpl;
}

export class AmusementVisionTextureHolder extends GXTextureHolder<AVTexture> {
    public addAVtplTextures(device: GfxDevice, avtpl: AVTpl): void {
        this.addTextures(device, avtpl.textures);
    }
}

class InstanceStateData {
    public jointToWorldMatrixVisibility: IntersectionState[] = [];
    public jointToWorldMatrixArray: mat4[] = [];
    public drawViewMatrixArray: mat4[] = [];
}

export class GcmfModel {
    public shapeHelperGfx: GXShapeHelperGfx[] = [];
    public materialData: MaterialData[] = [];
    private bufferCoalescer: GfxBufferCoalescerCombo;

    constructor(device: GfxDevice, cache: GfxRenderCache, public gcmfEntry: GMA.GcmfEntry, private materialHacks?: GX_Material.GXMaterialHacks) {
        const loadedVertexDatas: LoadedVertexData[] = [];
        gcmfEntry.gcmf.shapes.forEach(shape => {
            for (let i = 0; i < shape.loadedVertexDatas.length; i++) {
                loadedVertexDatas.push(shape.loadedVertexDatas[i]);
            }
        });
        this.bufferCoalescer = loadedDataCoalescerComboGfx(device, loadedVertexDatas);

        const gcmf = gcmfEntry.gcmf;
        let idx = 0;
        for (let i = 0; i < gcmf.shapes.length; i++) {
            const shape = gcmf.shapes[i];
            shape.loadedVertexDatas.forEach(loadedVertexDatas => {
                const coalescedBuffers = this.bufferCoalescer.coalescedBuffers[idx];
                const shapeData = new GXShapeHelperGfx(device, cache, coalescedBuffers.vertexBuffers, coalescedBuffers.indexBuffer, shape.loadedVertexLayout, loadedVertexDatas);
                this.shapeHelperGfx.push(shapeData);
                idx++;
            });
        }

        for (let i = 0; i < gcmf.shapes.length; i++) {
            for(let j = 0; j < 1; j++){
                const GcmfMaterial = gcmf.shapes[i].material;
                const samplerIdx = GcmfMaterial.samplerIdxs[j];
                if (samplerIdx < 0){
                    break;
                }
                const sampler = gcmf.samplers[samplerIdx];
                const material = new MaterialData(device, GcmfMaterial, sampler, this.materialHacks);
                this.materialData.push(material);
            }
        }
    }

    public destroy(device: GfxDevice): void {
        for (let i = 0; i < this.shapeHelperGfx.length; i++)
            this.shapeHelperGfx[i].destroy(device);
        for (let i = 0; i < this.materialData.length; i++)
            this.materialData[i].destroy(device);
        this.bufferCoalescer.destroy(device);
    }
}

const bboxScratch = new AABB();
const packetParams = new PacketParams();
class ShapeInstance {
    public sortKeyBias = 0;

    constructor(public shape: GMA.GcmfShape, public shapeData: GXShapeHelperGfx, public materialInstance: MaterialInstance, public shape_idx: number) {
    }

    public prepareToRender(device: GfxDevice, textureHolder: GXTextureHolder, renderInstManager: GfxRenderInstManager, depth: number, camera: Camera, viewport: Readonly<GfxNormalizedViewportCoords>, instanceStateData: InstanceStateData, isSkybox: boolean): void {
        const materialInstance = this.materialInstance;

        if (!materialInstance.visible)
            return;

        const template = renderInstManager.pushTemplateRenderInst();
        template.sortKey = materialInstance.sortKey;
        template.sortKey = setSortKeyDepth(template.sortKey, depth);
        template.sortKey = setSortKeyBias(template.sortKey, this.sortKeyBias);

        materialInstance.setOnRenderInst(device, renderInstManager.gfxRenderCache, template);

        const usesSkinning = this.shape.material.vtxRenderFlag < 0x08;

        for(let i = 0; i < this.shape.material.samplerIdxs.length; i++){
            if (this.shape.material.samplerIdxs[i] < 0){
                break;
            }
            materialInstance.fillMaterialParams(template, textureHolder, instanceStateData, this.shape.material.samplerIdxs[i], null, camera, viewport);
        }

        packetParams.clear();
        for (let d = 0; d < this.shape.loadedVertexDatas[this.shape_idx].draws.length; d++) {
            const draw = this.shape.loadedVertexDatas[this.shape_idx].draws[d];

            mat4.copy(packetParams.u_PosMtx[0], instanceStateData.drawViewMatrixArray[0]);

            const renderInst = renderInstManager.newRenderInst();
            this.shapeData.setOnRenderInst(renderInst, draw);
            materialInstance.materialHelper.allocatePacketParamsDataOnInst(renderInst, packetParams);

            renderInstManager.submitRenderInst(renderInst);
        }

        renderInstManager.popTemplateRenderInst();
    }
}

function colorChannelCopy(o: GX_Material.ColorChannelControl): GX_Material.ColorChannelControl {
    return Object.assign({}, o);
}

function lightChannelCopy(o: GX_Material.LightChannelControl): GX_Material.LightChannelControl {
    const colorChannel = colorChannelCopy(o.colorChannel);
    const alphaChannel = colorChannelCopy(o.alphaChannel);
    return { colorChannel, alphaChannel };
}

type CopyFunc<T> = (a: T) => T;

function arrayCopy<T>(a: T[], copyFunc: CopyFunc<T>): T[] {
    const b = Array(a.length);
    for (let i = 0; i < a.length; i++)
        b[i] = copyFunc(a[i]);
    return b;
}

const matrixScratch = mat4.create();
const materialParams = new MaterialParams();
class MaterialInstance {
    public materialHelper: GXMaterialHelperGfx;
    public sortKey: number = 0;
    public visible = true;

    constructor(private modelInstance: GcmfModelInstance, public materialData: MaterialData, public samplers: GMA.GcmfSampler[], public modelID: number, transparent?: boolean) {
        const lightChannel0: GX_Material.LightChannelControl = {
            alphaChannel: { lightingEnabled: false, ambColorSource: GX.ColorSrc.VTX, matColorSource: GX.ColorSrc.VTX, litMask: 0, diffuseFunction: GX.DiffuseFunction.NONE, attenuationFunction: GX.AttenuationFunction.NONE },
            colorChannel: { lightingEnabled: false, ambColorSource: GX.ColorSrc.VTX, matColorSource: GX.ColorSrc.VTX, litMask: 0, diffuseFunction: GX.DiffuseFunction.NONE, attenuationFunction: GX.AttenuationFunction.NONE },
        };

        const lightChannels: GX_Material.LightChannelControl[] = [lightChannel0, lightChannel0];
        const material = this.materialData.material;
        let mat_unk0x02 = material.unk0x02;
        let mat_unk0x03 = material.unk0x03;

        const mb = new GXMaterialBuilder();
        const matCount = material.matCount;
        for(let i = 0; i < matCount; i++){
            mb.setTevDirect(i);
            let ambSrc = i === 0 ? GX.ColorSrc.VTX : GX.ColorSrc.REG;
            let matSrc = i === 0 ? GX.ColorSrc.VTX : GX.ColorSrc.REG;
            mb.setChanCtrl(GX.ColorChannelID.COLOR0A0, false, ambSrc, matSrc, 0, GX.DiffuseFunction.NONE, GX.AttenuationFunction.NONE);
            mb.setTevOrder(i, (GX.TexCoordID.TEXCOORD0 + i) as GX.TexCoordID, (GX.TexMapID.TEXMAP0 + i) as GX.TexMapID, GX.RasColorChannelID.COLOR0A0);
            const samplerIdx = material.samplerIdxs[i];
            const sampler = this.samplers[samplerIdx];
            let samp_unk0x0C = this.samplers[i].unk0x0C;
            const colorType = sampler.colorType;
            const alphaType = sampler.alphaType;
            const mipmapAV = sampler.mipmapAV;

            // Color
            let colorInA = GX.CC.TEXC;
            let colorInB = GX.CC.ZERO;
            let colorInC = GX.CC.ZERO;
            let colorInD = GX.CC.ZERO;
            let colorOp = GX.TevOp.ADD;
            let TevOp = GX.TevBias.ZERO;
            let colorScale = GX.TevScale.SCALE_1;
            let colorRegId = GX.Register.PREV;
            let sel = GX.KonstColorSel.KCSEL_1;

            

            if (i === 0 && ( (material.vtxAttr & (1 << GX.Attr.CLR0)) !== 0) ){
                // vertex color
                colorInA = GX.CC.ZERO;
                colorInB = GX.CC.TEXC;
                colorInC = GX.CC.RASC;
            }
            if (i > 0 && (colorType === 0) ){
                // tev stage more than 1
                colorInA = GX.CC.ZERO;
                colorInB = GX.CC.TEXC;
                colorInC = GX.CC.CPREV;
            }
            if ( (colorType & 1) !== 0 ){
                // 0x1
                colorInA = GX.CC.TEXC;
                colorInB = GX.CC.TEXC;
                colorInC = GX.CC.TEXA;
                colorInD = GX.CC.CPREV;

                // colorInB = GX.CC.TEXA;
                // colorInC = GX.CC.TEXC;
            }
            if ( (colorType & (1 << 1)) !== 0 ){
                // 0x2 sub
                colorInA = GX.CC.CPREV;
                colorInB = GX.CC.ZERO;
                colorInC = GX.CC.TEXC;
            }
            if ( (colorType & (1 << 2)) !== 0 ){
                // 0x4
                colorInA = GX.CC.CPREV;
                colorInB = GX.CC.TEXC;
                colorInC = GX.CC.TEXA;
                colorInD = GX.CC.ZERO;
            }

            // if (0x03){
            //                     //3
            // colorInA = GX.CC.ZERO;
            // colorInB = GX.CC.ZERO;
            // colorInC = GX.CC.TEXA;
            // colorInD = GX.CC.CPREV;
            // colorOp = GX.TevOp.ADD;
            // TevOp = GX.TevBias.ZERO;
            // colorScale = GX.TevScale.SCALE_1;
            // colorRegId = GX.Register.PREV;
            // sel = GX.KonstColorSel.KCSEL_1;
                
                
            // }

            // switch (colorType){
            //     case(0):
            //         if (i === 0){
            //             colorInD = GX.CC.TEXC;
            //         } else {
            //             colorInA = GX.CC.TEXC;
            //             colorInC = GX.CC.KONST;
            //             colorInD = GX.CC.CPREV;
            //             TevOp = GX.TevBias.SUBHALF;
            //             sel = GX.KonstColorSel.KCSEL_4_8;
            //         }
            //         break;
            //     case(1):
            //         colorInA = GX.CC.TEXC;
            //         colorInD = GX.CC.CPREV;
            //         break;
            //     case(2):
            //         colorInA = GX.CC.TEXC;
            //         colorInD = GX.CC.CPREV;
            //         colorOp = GX.TevOp.SUB;
            //         break;
            //     case(3):
            //         colorInD = GX.CC.CPREV;
            //         break;
            //     case(4):
            //         colorInA = GX.CC.CPREV;
            //         colorInB = GX.CC.TEXC;
            //         colorInC = GX.CC.TEXA;
            //         break;
            //     default:
            //         colorInD = GX.CC.TEXC;
            //         break;
            // }
            
            mb.setTevKColorSel(i, sel);
            mb.setTevColorIn(i, colorInA, colorInB, colorInC, colorInD);
            mb.setTevColorOp(i, colorOp, TevOp, colorScale, true, colorRegId);
            
            sel = GX.KonstColorSel.KCSEL_1;
            // Alpha
            let alphaInA = GX.CA.TEXA;
            let alphaInB = GX.CA.ZERO;
            let alphaInC = GX.CA.ZERO;
            let alphaInD = GX.CA.ZERO;
            let alphaOp = GX.TevOp.ADD;
            let alphaScale = GX.TevScale.SCALE_1;
            let alphaRegId = GX.Register.PREV;

            if ( (alphaType & (1 << 1)) !== 0 ){
                // colorInD = GX.CC.CPREV;
                alphaInD = GX.CA.APREV;
            }
            if ( (alphaType & (1 << 2)) !== 0 ){
                alphaOp = GX.TevOp.SUB;
            }
            if ( (alphaType & (1 << 0)) !== 0 ){
                // input swap?
                alphaInD = GX.CA.APREV;
            }
            // switch (alphaType){
            //     case(0):
            //         alphaInD = GX.CA.TEXA;
            //         break;
            //     case(1):
            //         alphaInA = GX.CA.TEXA;
            //         alphaInD = GX.CA.APREV;
            //         break;
            //     case(2):
            //         alphaInA = GX.CA.TEXA;
            //         alphaInD = GX.CA.APREV;
            //         colorOp = GX.TevOp.SUB;
            //         break;
            //     case(3):
            //         alphaInD = i === 0 ? GX.CA.TEXA : GX.CA.APREV;
            //         break;
            //     default:
            //         alphaInD = i === 0 ? GX.CA.KONST : GX.CA.APREV;
            //         break;
            // }

            mb.setTevAlphaIn(i, alphaInA, alphaInB, alphaInC, alphaInD);
            mb.setTevAlphaOp(i, alphaOp, TevOp, alphaScale, true, alphaRegId);
            mb.setTevKAlphaSel(i, GX.KonstAlphaSel.KASEL_1);

            const uvWrap = sampler.uvWrap;
            const unk0x00 = sampler.unk0x00;
            mb.setTexCoordGen(i, GX.TexGenType.MTX2x4, (GX.TexGenSrc.TEX0 + i) as GX.TexGenSrc, (uvWrap & 1) !== 0 ? GX.TexGenMatrix.PNMTX0 : GX.TexGenMatrix.IDENTITY, false, (unk0x00 & (1 << 8)) !== 0 ? GX.PostTexGenMatrix.PTTEXMTX0 : GX.PostTexGenMatrix.PTIDENTITY);
        }

        // if ((material.vtxAttr & (1 << GX.Attr.CLR0)) !== 0){
        //     mb.setTevColorIn(i, GX.CC.ZERO, GX.CC.TEXC, GX.CC.RASC, GX.CC.ZERO);
        // } else {
        //     mb.setTevColorIn(i, GX.CC.ZERO, GX.CC.ZERO, GX.CC.ZERO, GX.CC.TEXC);

        // unk0x03 << 0 : ???           0x00000001
        // unk0x03 << 1 : culling       0x00000002
        // unk0x03 << 2 : ???           0x00000004 relate Zmode??
        // unk0x03 << 3 : ???           0x00000008
        // unk0x03 << 4 : ???           0x00000010
        // unk0x03 << 5 : depthWrite?   0x00000020
        // unk0x03 << 6 : blend?        0x00000040  (relate 0x3C's 0x00000010)
        //
        // 0x63 blending
        // 0x65
        mb.setZMode(true, GX.CompareType.LEQUAL, (mat_unk0x03 & (1 << 5)) !== 0 ? false : true);

        if (transparent){
            // texture conatins "alpha" value
            mb.setAlphaCompare(GX.CompareType.GEQUAL, material.transparents[0], GX.AlphaOp.AND, GX.CompareType.LEQUAL, material.transparents[1]);
        } else {
            mb.setAlphaCompare(GX.CompareType.ALWAYS, 0, GX.AlphaOp.AND, GX.CompareType.ALWAYS, 0);
        }

        let dstFactor = GX.BlendFactor.INVSRCALPHA;
        if ((mat_unk0x03 & (1 << 6)) !== 0){
            // Blend Dsetination Factor?
            dstFactor = GX.BlendFactor.ONE;
        }
        mb.setBlendMode(GX.BlendMode.BLEND, GX.BlendFactor.SRCALPHA, dstFactor, GX.LogicOp.COPY)

        this.materialHelper = new GXMaterialHelperGfx(mb.finish(), materialData.materialHacks);

        let layer = transparent ? GfxRendererLayer.TRANSLUCENT : GfxRendererLayer.OPAQUE;
        this.setSortKeyLayer(layer);
    }

    public setSortKeyLayer(layer: GfxRendererLayer): void {
        this.sortKey = makeSortKey(layer);
    }

    public setMaterialHacks(materialHacks: GX_Material.GXMaterialHacks): void {
        this.materialHelper.setMaterialHacks(materialHacks);
    }

    private calcTexMatrix(materialParams: MaterialParams, texIdx: number, camera: Camera, viewport: Readonly<GfxNormalizedViewportCoords>): void {
        const material = this.materialData.material;
        const flipY = materialParams.m_TextureMapping[texIdx].flipY;
        const flipYScale = flipY ? -1.0 : 1.0;
        const dstPost = materialParams.u_PostTexMtx[texIdx];

        mat4.identity(dstPost);

        mat4.mul(dstPost, matrixScratch, dstPost);
    }

    private calcColor(materialParams: MaterialParams, i: ColorKind, fallbackColor: Color): void {
        const dst = materialParams.u_Color[i];
        let color: Color;
        if (this.modelInstance && this.modelInstance.colorOverrides[i]) {
            color = this.modelInstance.colorOverrides[i];
        } else {
            color = fallbackColor;
        }

        colorCopy(dst, color);
    }

    private fillMaterialParamsData(materialParams: MaterialParams, textureHolder: GXTextureHolder, instanceStateData: InstanceStateData, posNrmMatrixIdx: number, draw: LoadedVertexDraw | null = null, camera: Camera, viewport: Readonly<GfxNormalizedViewportCoords>): void {
        const material = this.materialData.material;

        for (let i = 0; i < 3; i++) {
            const m = materialParams.m_TextureMapping[i];
            m.reset();

            this.fillTextureMapping(m, textureHolder, i);
        }
    }

    private fillTextureMapping(dst: TextureMapping, textureHolder: GXTextureHolder, i: number): void {
        const material = this.materialData.material;
        dst.reset();
        let samplerIdx = material.samplerIdxs[i];
        if(samplerIdx < 0){
            return;
        }
        let texIdx = 0;
        texIdx = this.samplers[samplerIdx].texIdx;
        const name: string = `texture_${this.modelID}_${texIdx}`;
        textureHolder.fillTextureMapping(dst, name);
        dst.gfxSampler = this.materialData.gfxSamplers[i];
        dst.lodBias = this.samplers[samplerIdx].lodBias;
    }

    public setOnRenderInst(device: GfxDevice, cache: GfxRenderCache, renderInst: GfxRenderInst): void {
        this.materialHelper.setOnRenderInst(device, cache, renderInst);
    }

    public fillMaterialParams(renderInst: GfxRenderInst, textureHolder: GXTextureHolder, instanceStateData: InstanceStateData, posNrmMatrixIdx: number, packet: LoadedVertexDraw | null, camera: Camera, viewport: Readonly<GfxNormalizedViewportCoords>): void {
        this.fillMaterialParamsData(materialParams, textureHolder, instanceStateData, posNrmMatrixIdx, packet, camera, viewport);
        this.materialHelper.allocateMaterialParamsDataOnInst(renderInst, materialParams);
        renderInst.setSamplerBindingsFromTextureMappings(materialParams.m_TextureMapping);
    }

    public destroy(device: GfxDevice): void {
    }
}


const matrixScratchArray = nArray(1, () => mat4.create());
export class GcmfModelInstance {
    public shapeInstances: ShapeInstance[] = [];
    public materialInstances: MaterialInstance[] = [];

    private instanceStateData = new InstanceStateData();

    public colorOverrides: Color[] = [];

    public modelMatrix: mat4 = mat4.create();
    public visible: boolean = true;
    public name: string;
    public isSkybox: boolean = false;
    public passMask: number = 1;
    public templateRenderInst: GfxRenderInst;

    constructor(public textureHolder: GXTextureHolder, public gcmfModel: GcmfModel, modelID: number, public namePrefix: string = '') {
        this.name = `${namePrefix}/${gcmfModel.gcmfEntry.name}`;

        this.instanceStateData.jointToWorldMatrixArray = nArray(gcmfModel.gcmfEntry.gcmf.mtxCount, () => mat4.create());
        this.instanceStateData.drawViewMatrixArray = nArray(1, () => mat4.create());
        for (let i = 0; i < this.gcmfModel.materialData.length; i++){
            const transparent = i >= this.gcmfModel.gcmfEntry.gcmf.materialCount;
            this.materialInstances[i] = new MaterialInstance(this, this.gcmfModel.materialData[i], this.gcmfModel.gcmfEntry.gcmf.samplers, modelID, transparent);
        }

        const gcmf = this.gcmfModel.gcmfEntry.gcmf;
        let idx = 0;
        for (let i = 0; i < gcmf.shapes.length; i++) {
            const materialInstance = this.materialInstances[i];
            const shape = gcmf.shapes[i];
            for (let j = 0; j < shape.loadedVertexDatas.length; j++){
                const shapeData = this.gcmfModel.shapeHelperGfx[idx];
                const shapeInstance = new ShapeInstance(shape, shapeData, materialInstance, j);
                this.shapeInstances.push(shapeInstance);
                idx++;
            }
        }
    }

    public setSortKeyLayer(layer: GfxRendererLayer): void {
        for (let i = 0; i < this.materialInstances.length; i++)
            this.materialInstances[i].setSortKeyLayer(layer);
    }

    public setVertexColorsEnabled(v: boolean): void {
        for (let i = 0; i < this.materialInstances.length; i++)
            this.materialInstances[i].setMaterialHacks({ disableVertexColors: !v });
    }

    public setTexturesEnabled(v: boolean): void {
        for (let i = 0; i < this.materialInstances.length; i++)
            this.materialInstances[i].setMaterialHacks({ disableTextures: !v });
    }

    public setColorOverride(i: ColorKind, color: Color): void {
        this.colorOverrides[i] = color;
    }

    public setVisible(visible: boolean): void {
        this.visible = visible;
    }

    private calcView(camera: Camera): void {
        const viewMatrix = matrixScratch;

        if (this.isSkybox){
            computeViewMatrixSkybox(viewMatrix, camera);

        } else{
            computeViewMatrix(viewMatrix, camera);
        }

        const dstDrawMatrix = this.instanceStateData.drawViewMatrixArray[0];

        mat4.mul(dstDrawMatrix, viewMatrix, this.modelMatrix);
    }

    public prepareToRender(device: GfxDevice, renderInstManager: GfxRenderInstManager, viewerInput: ViewerRenderInput): void {
        let modelVisibility = this.visible ? IntersectionState.PARTIAL_INTERSECT : IntersectionState.FULLY_OUTSIDE;
        const gcmf = this.gcmfModel.gcmfEntry.gcmf;
        const camera = viewerInput.camera;

        if (modelVisibility !== IntersectionState.FULLY_OUTSIDE) {
            if (this.isSkybox) {
                modelVisibility = IntersectionState.FULLY_INSIDE;
            } else {
                let bbox = new AABB();
                bbox.set(-gcmf.boundSpeher, -gcmf.boundSpeher, -gcmf.boundSpeher, gcmf.boundSpeher, gcmf.boundSpeher, gcmf.boundSpeher);
                bboxScratch.transform(bbox, this.modelMatrix);
                if (!viewerInput.camera.frustum.contains(bboxScratch))
                    modelVisibility = IntersectionState.FULLY_OUTSIDE;
            }
        }

        let depth = 2;
        this.calcView(camera);

        const template = renderInstManager.pushTemplateRenderInst();
        template.filterKey = this.passMask;
        for (let i = 0; i < this.shapeInstances.length; i++) {
            const shapeInstance = this.shapeInstances[i];
            shapeInstance.prepareToRender(device, this.textureHolder, renderInstManager, depth, camera, viewerInput.viewport, this.instanceStateData, this.isSkybox);
        }
        renderInstManager.popTemplateRenderInst();
    }

    public destroy(device: GfxDevice): void {
        for (let i = 0; i < this.materialInstances.length; i++)
            this.materialInstances[i].destroy(device);
    }

}


class MaterialData {
    public gfxSamplers: GfxSampler[] = [];

    constructor(device: GfxDevice, public material: GMA.GcmfMaterial, public sampler: GMA.GcmfSampler, public materialHacks?: GX_Material.GXMaterialHacks) {
        function translateAVTexFilterGfx(mipmapAV: number): [GfxTexFilterMode, GfxMipFilterMode] {
            // "Debug Mode" Menu showing like this
            // 0x00: "LINER & MIPMAP NEAR, LINER"  (mipmap: 0) linear?
            // 0x01: "LINER & MIPMAP LINER, LINER" (mipmap: 1) binear?
            // 0x02: "LINER & MIPMAP LINER, LINER" (mipmap: 3) trilinear?
            // 0x04: "LINER & MIPMAP LINER, LINER"
            // 0x08: "NEAR & MIPMAP NEAR, NEAR (NEAR FLAG)" (mipmap: 0)
            // 0x10: "LINER & MIPMAP NEAR, LINER"
            let texFilter = GfxTexFilterMode.BILINEAR;
            let MipFilter = GfxMipFilterMode.NO_MIP;

            if ((mipmapAV & (1 << 1)) !== 0){
                texFilter = GfxTexFilterMode.BILINEAR;
                MipFilter = GfxMipFilterMode.LINEAR;
            }

            return [ texFilter, MipFilter ]
        }

        for (let i = 0; i < 8; i++) {
            const uvWrap = sampler.uvWrap;
            const wrapS = (uvWrap >> 2) & 0x03 as GX.WrapMode;
            const wrapT = (uvWrap >> 4) & 0x03 as GX.WrapMode;

            const [minFilter, mipFilter] = translateAVTexFilterGfx(sampler.mipmapAV);
            const [magFilter]            = translateAVTexFilterGfx(sampler.mipmapAV);

            const gfxSampler = device.createSampler({
                wrapS: translateWrapModeGfx(wrapS),
                wrapT: translateWrapModeGfx(wrapT),
                minFilter,
                mipFilter,
                magFilter,
                minLOD: 0,
                maxLOD: 100,
            });

            this.gfxSamplers[i] = gfxSampler;
        }
    }

    public destroy(device: GfxDevice): void {
        this.gfxSamplers.forEach((r) => device.destroySampler(r));
    }
}
