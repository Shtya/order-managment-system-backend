import { ArrayMaxSize, ArrayMinSize, IsBoolean, IsEnum, IsNotEmpty, IsNumber, IsObject, IsOptional, IsString, Validate, ValidateNested, ValidationArguments, ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';
import { Type } from 'class-transformer';
import { ActionType, ConditionType, FlowNodeDataType, FlowNodeType, NodeConfig, SendWhatsappTemplateConfig, TriggerType } from 'entities/automation.entity';
import { OmitType } from '@nestjs/mapped-types';

@ValidatorConstraint({ name: 'UniqueNodeIds', async: false })
export class UniqueNodeIdsConstraint implements ValidatorConstraintInterface {
    validate(nodes: FlowNodeDto[]) {
        if (!Array.isArray(nodes)) return true;
        const ids = nodes.map((n) => n.id).filter(Boolean);
        return ids.length === new Set(ids).size;
    }
    defaultMessage() { return 'Duplicate node IDs found'; }
}

@ValidatorConstraint({ name: 'UniqueEdgeIds', async: false })
export class UniqueEdgeIdsConstraint implements ValidatorConstraintInterface {
    validate(edges: FlowEdgeDto[]) {
        if (!Array.isArray(edges)) return true;
        const ids = edges.map((e) => e.id).filter(Boolean);
        return ids.length === new Set(ids).size;
    }
    defaultMessage() { return 'Duplicate edge IDs found'; }
}

@ValidatorConstraint({ name: 'ValidFlowGraph', async: false })
export class ValidFlowGraphConstraint implements ValidatorConstraintInterface {
    private errorMessage = 'Invalid flow graph';

    validate(_: any, args: ValidationArguments) {
        const flow = args.object as FlowDefinitionDto;
        const nodes = flow.nodes || [];
        const edges = flow.edges || [];

        // 1. Exactly one trigger node
        const triggerNodes = nodes.filter(n => n.type === FlowNodeType.TRIGGER);
        if (triggerNodes.length !== 1) {
            this.errorMessage = `Flow must have exactly one trigger node. Found ${triggerNodes.length}.`;
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
                this.errorMessage = `Edge source "${edge.source}" does not exist.`;
                return false;
            }
            if (!nodeIds.has(edge.target)) {
                this.errorMessage = `Edge target "${edge.target}" does not exist.`;
                return false;
            }

            // Trigger has no incoming edges
            if (edge.target === trigger.id) {
                this.errorMessage = `Trigger node cannot have incoming edges.`;
                return false;
            }

            // Unique source + sourceHandle + target
            const connKey = `${edge.source}|${edge.sourceHandle || ''}|${edge.target}`;
            if (connections.has(connKey)) {
                this.errorMessage = `Duplicate connection found: ${edge.source} -> ${edge.target} via ${edge.sourceHandle || 'default'}`;
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
                    this.errorMessage =
                        `Invalid sourceHandle "${edge.sourceHandle}" for node "${edge.source}". ` +
                        `Expected one of: ${branchIds.join(', ')}`;

                    return false;
                }
            }
        }

        // 5. All nodes except trigger must have at least one incoming edge
        for (const [id, count] of incomingEdgesCount.entries()) {
            if (id !== trigger.id && count === 0) {
                this.errorMessage = `Node "${id}" is unreachable (no incoming edges).`;
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
            this.errorMessage = 'Flow graph is not fully connected from the trigger node.';
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
            this.errorMessage = 'Flow graph contains a circular reference (cycle).';
            return false;
        }

        return true;
    }

    defaultMessage() {
        return this.errorMessage;
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
        return `Invalid data.type "${data?.type}" for node.type "${node?.type}"`;
    }
}


class FlowNodePositionDto {
    @IsNumber()
    x: number;

    @IsNumber()
    y: number;
}

class FlowNodeDataDto {
    @IsNotEmpty()
    @IsString()
    label: string;

    @IsNotEmpty()
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

    @IsNotEmpty()
    @IsObject()
    config: NodeConfig;
}


class FlowNodeDto {
    @IsString()
    @IsNotEmpty()
    id: string;

    @IsEnum(FlowNodeType)
    type: FlowNodeType;

    @ValidateNested()
    @Type(() => FlowNodePositionDto)
    position: FlowNodePositionDto;

    @IsOptional()
    @IsObject()
    measured?: { width: number; height: number };

    @ValidateNested()
    @Validate(NodeDataMatchesNodeTypeConstraint)
    @Type(() => FlowNodeDataDto)
    data: FlowNodeDataDto;
}

class FlowEdgeDto {
    @IsString()
    @IsNotEmpty()
    id: string;

    @IsString()
    @IsNotEmpty()
    source: string;

    @IsString()
    @IsNotEmpty()
    target: string;

    @IsOptional()
    @IsString()
    sourceHandle?: string;

    @IsOptional()
    @IsString()
    targetHandle?: string;
}

class FlowDefinitionDto {
    @Validate(ValidFlowGraphConstraint)
    @ValidateNested({ each: true })
    @Validate(UniqueNodeIdsConstraint)
    @ArrayMinSize(2, {
        message: 'Flow must contain at least 2 nodes',
    })
    @ArrayMaxSize(100, {
        message: 'Flow must contain at most 100 nodes',
    })
    @Type(() => FlowNodeDto)
    nodes: FlowNodeDto[];

    @ValidateNested({ each: true })
    @Validate(UniqueEdgeIdsConstraint)
    @Type(() => FlowEdgeDto)
    edges: FlowEdgeDto[];

}

export class CreateAutomationDto {
    @IsString()
    @IsNotEmpty()
    name: string;

    @IsEnum(TriggerType)
    triggerType: TriggerType;

    @ValidateNested()
    @Type(() => FlowDefinitionDto)
    flow: FlowDefinitionDto;

    @IsOptional()
    @IsBoolean()
    publish?: boolean;
}


export class UpdateAutomationDto {
    @ValidateNested()
    @Type(() => FlowDefinitionDto)
    flow: FlowDefinitionDto;

    @IsOptional()
    @IsString()
    version?: string;
}
