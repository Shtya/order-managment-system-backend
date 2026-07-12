import { ArrayMaxSize, ArrayMinSize, IsBoolean, IsEnum, IsNotEmpty, IsNumber, IsObject, IsOptional, IsString, Validate, ValidateNested, ValidationArguments, ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';
import { Type } from 'class-transformer';
import { ActionType, ConditionType, FlowNodeDataType, FlowNodeType, NodeConfig, SendWhatsappTemplateConfig, TriggerType } from 'entities/automation.entity';
import { i18nValidationMessage } from 'nestjs-i18n';


@ValidatorConstraint({ name: 'UniqueNodeIds', async: false })
export class UniqueNodeIdsConstraint implements ValidatorConstraintInterface {
    validate(nodes: FlowNodeDto[]) {
        if (!Array.isArray(nodes)) return true;
        const ids = nodes.map((n) => n.id).filter(Boolean);
        return ids.length === new Set(ids).size;
    }
    defaultMessage(args: ValidationArguments) { 
        return i18nValidationMessage('validation.unique_node_ids')(args); 
    }
}

@ValidatorConstraint({ name: 'UniqueEdgeIds', async: false })
export class UniqueEdgeIdsConstraint implements ValidatorConstraintInterface {
    validate(edges: FlowEdgeDto[]) {
        if (!Array.isArray(edges)) return true;
        const ids = edges.map((e) => e.id).filter(Boolean);
        return ids.length === new Set(ids).size;
    }
    defaultMessage(args: ValidationArguments) { 
        return i18nValidationMessage('validation.unique_edge_ids')(args); 
    }
}

@ValidatorConstraint({ name: 'ValidFlowGraph', async: false })
export class ValidFlowGraphConstraint implements ValidatorConstraintInterface {
    private errorKey = 'validation.invalid_flow_graph';
    private errorArgs: Record<string, any> = {};

    validate(_: any, args: ValidationArguments) {
        const flow = args.object as FlowDefinitionDto;
        const nodes = flow.nodes || [];
        const edges = flow.edges || [];

        // 1. Exactly one trigger node
        const triggerNodes = nodes.filter(n => n.type === FlowNodeType.TRIGGER);
        if (triggerNodes.length !== 1) {
            this.errorKey = 'validation.exactly_one_trigger_node';
            this.errorArgs = { count: triggerNodes.length };
            return false;
        }
        const trigger = triggerNodes[0];

        const nodeMap = new Map(nodes.map(n => [n.id, n]));
        const nodeIds = new Set(nodeMap.keys());

        // 2. Edge source/target existence and handle validity
        const connections = new Set<string>();
        const incomingEdgesCount = new Map<string, number>();
        nodeIds.forEach(id => incomingEdgesCount.set(id, 0));

        for (const edge of edges) {
            if (!nodeIds.has(edge.source)) {
                this.errorKey = 'validation.edge_source_not_exist';
                this.errorArgs = { source: edge.source };
                return false;
            }
            if (!nodeIds.has(edge.target)) {
                this.errorKey = 'validation.edge_target_not_exist';
                this.errorArgs = { target: edge.target };
                return false;
            }

            // Trigger has no incoming edges
            if (edge.target === trigger.id) {
                this.errorKey = 'validation.trigger_cannot_have_incoming_edges';
                this.errorArgs = {};
                return false;
            }

            // Unique source + sourceHandle + target
            const connKey = `${edge.source}|${edge.sourceHandle || ''}|${edge.target}`;
            if (connections.has(connKey)) {
                this.errorKey = 'validation.duplicate_connection';
                this.errorArgs = { source: edge.source, target: edge.target, sourceHandle: edge.sourceHandle || 'default' };
                return false;
            }
            connections.add(connKey);

            incomingEdgesCount.set(edge.target, (incomingEdgesCount.get(edge.target) || 0) + 1);

            // 6. Branch ID validation (sourceHandle must match node branches if any)
            const sourceNode = nodeMap.get(edge.source);

            const branches = (sourceNode.data.config as SendWhatsappTemplateConfig).branches;
            if (!!branches && branches.length > 0) {

                const branchIds = branches.map((b) => b.id);

                if (!branchIds.includes(edge.sourceHandle)) {
                    this.errorKey = 'validation.invalid_source_handle';
                    this.errorArgs = { sourceHandle: edge.sourceHandle, source: edge.source, expectedBranches: branchIds.join(', ') };
                    return false;
                }
            }
        }

        // 5. All nodes except trigger must have at least one incoming edge
        for (const [id, count] of incomingEdgesCount.entries()) {
            if (id !== trigger.id && count === 0) {
                this.errorKey = 'validation.node_unreachable';
                this.errorArgs = { id };
                return false;
            }
        }

        // Connectivity and Cycle Detection (BFS from trigger)
        const adj = new Map<string, string[]>();
        edges.forEach(e => {
            if (!adj.has(e.source)) adj.set(e.source, []);
            adj.get(e.source)!.push(e.target);
        });

        // Simple connectivity check first
        const reached = new Set<string>();
        const queue: string[] = [trigger.id];

        let head = 0;

        while (head < queue.length) {
            const curr = queue[head++];

            if (reached.has(curr)) continue;

            reached.add(curr);

            const neighbors = adj.get(curr);
            if (!neighbors) continue;

            for (const next of neighbors) {
                if (!reached.has(next)) {
                    queue.push(next);
                }
            }
        }

        if (reached.size !== nodes.length) {
            this.errorKey = 'validation.flow_not_fully_connected';
            this.errorArgs = {};
            return false;
        }

        // Cycle detection using DFS
        const hasCycle = (u: string, visited: Set<string>, recStack: Set<string>): boolean => {
            visited.add(u);
            recStack.add(u);
            for (const neighbor of (adj.get(u) || [])) {
                if (!visited.has(neighbor)) {
                    if (hasCycle(neighbor, visited, recStack)) return true;
                } else if (recStack.has(neighbor)) {
                    return true;
                }
            }
            recStack.delete(u);
            return false;
        };

        const visited = new Set<string>();
        const recStackSet = new Set<string>();
        if (hasCycle(trigger.id, visited, recStackSet)) {
            this.errorKey = 'validation.flow_circular_reference';
            this.errorArgs = {};
            return false;
        }

        return true;
    }

    defaultMessage(args: ValidationArguments) {
        return i18nValidationMessage(this.errorKey)({ ...(args as any), ...this.errorArgs });
    }
}
@ValidatorConstraint({ name: 'NodeDataMatchesNodeType', async: false })
export class NodeDataMatchesNodeTypeConstraint
    implements ValidatorConstraintInterface {
    validate(data: FlowNodeDataDto, args: ValidationArguments) {
        const node = args.object as FlowNodeDto;
        if (!node?.type || !data?.type) return false;

        switch (node.type) {
            case FlowNodeType.TRIGGER:
                return Object.values(TriggerType).includes(data.type as TriggerType);
            case FlowNodeType.ACTION:
                return Object.values(ActionType).includes(data.type as ActionType);
            case FlowNodeType.CONDITION:
                return Object.values(ConditionType).includes(data.type as ConditionType);
            default:
                return false;
        }
    }

    defaultMessage(args: ValidationArguments) {
        const node = args.object as FlowNodeDto;
        const data = args.value as FlowNodeDataDto;
        return i18nValidationMessage('validation.invalid_data_type_for_node_type')({ 
            ...(args as any), 
            dataType: data?.type, 
            nodeType: node?.type 
        });
    }
}


class FlowNodePositionDto {
    @IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
    x: number;

    @IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
    y: number;
}

class FlowNodeDataDto {
    @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
    @IsString({message: i18nValidationMessage('validation.is_string')})
    label: string;

    @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
    @IsEnum(
        {
            ...TriggerType,
            ...ActionType,
            ...ConditionType,
        },
        {
            message: 'Invalid flow node data type',
        },
    )
    type: FlowNodeDataType;

    @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
    @IsObject({message: i18nValidationMessage('validation.is_object')})
    config: NodeConfig;
}


class FlowNodeDto {
    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
    id: string;

    @IsEnum(FlowNodeType,{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(FlowNodeType).join(', ')], }); }})
    type: FlowNodeType;

    @ValidateNested()
    @Type(() => FlowNodePositionDto)
    position: FlowNodePositionDto;

    @IsOptional()
    @IsObject({message: i18nValidationMessage('validation.is_object')})
    measured?: { width: number; height: number };

    @ValidateNested()
    @Validate(NodeDataMatchesNodeTypeConstraint)
    @Type(() => FlowNodeDataDto)
    data: FlowNodeDataDto;
}

class FlowEdgeDto {
    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
    id: string;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
    source: string;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
    target: string;

    @IsOptional()
    @IsString({message: i18nValidationMessage('validation.is_string')})
    sourceHandle?: string;

    @IsOptional()
    @IsString({message: i18nValidationMessage('validation.is_string')})
    targetHandle?: string;
}

class OrphanFilesDto {
    @IsOptional()
    @IsString({ each: true })
    @Type(() => String)
    deletedOldUrls?: string[];

    @IsOptional()
    @IsString({ each: true })
    @Type(() => String)
    newIds?: string[];
}

class FlowDefinitionDto {
    @Validate(ValidFlowGraphConstraint)
    @ValidateNested({ each: true })
    @Validate(UniqueNodeIdsConstraint)
    @ArrayMinSize(2, {
        message: i18nValidationMessage('validation.array_min_size'),
    })
    @ArrayMaxSize(100, {
        message: i18nValidationMessage('validation.array_max_size'),
    })
    @Type(() => FlowNodeDto)
    nodes: FlowNodeDto[];

    @ValidateNested({ each: true })
    @Validate(UniqueEdgeIdsConstraint)
    @Type(() => FlowEdgeDto)
    edges: FlowEdgeDto[];

}

export class CreateAutomationDto {
    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
    name: string;

    @IsEnum(TriggerType,{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(TriggerType).join(', ')], }); }})
    triggerType: TriggerType;

    @ValidateNested()
    @Type(() => FlowDefinitionDto)
    flow: FlowDefinitionDto;

    
    @IsOptional()
    @IsBoolean({message: i18nValidationMessage('validation.is_boolean')})
    publish?: boolean;

    @IsOptional()
    @ValidateNested()
    @Type(() => OrphanFilesDto)
    orphanFiles?: OrphanFilesDto;
}


export class UpdateAutomationDto {
    @ValidateNested()
    @Type(() => FlowDefinitionDto)
    flow: FlowDefinitionDto;

    // @IsOptional()
    // @IsString({message: i18nValidationMessage('validation.is_string')})
    // version?: string;

    @IsOptional()
    @ValidateNested()
    @Type(() => OrphanFilesDto)
    orphanFiles?: OrphanFilesDto;
}
